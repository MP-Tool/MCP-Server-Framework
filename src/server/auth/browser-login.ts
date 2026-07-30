/**
 * Browser-based OAuth 2.1 / OIDC login (Authorization Code + PKCE).
 *
 * A generic, interactive login flow for MCP servers running in **stdio** mode (or any
 * context without an MCP-client-driven OAuth handshake). The server opens the user's
 * browser, the user authenticates with an upstream provider (a generic OIDC issuer,
 * Google, or GitHub), and the provider redirects back to a callback route the server
 * mounts on its own HTTP app.
 *
 * The flow returns the upstream **provider token** (an OIDC/Google `id_token`, or a
 * GitHub `access_token`). The consumer decides what to do with it — e.g. exchange it
 * for a downstream service credential. This module is intentionally free of any
 * consumer-specific credential mapping or token minting.
 *
 * ## Usage
 * ```ts
 * const login = createBrowserOAuthLogin();
 * // 1. Mount callback routes on the server's Express app (e.g. via configureHttpApp):
 * createServer({ configureHttpApp: (app) => login.registerCallbackRoutes(app), ... });
 * // 2. Acquire a token (opens the browser, resolves when the callback completes):
 * const { providerToken, claims } = await login.acquireToken({
 *   provider: "oidc", clientId, clientSecret, issuer, redirectBaseUrl: deriveServerBaseUrl(),
 * });
 * ```
 *
 * @module server/auth/browser-login
 */

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

import type { Application, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";

import { logger as baseLogger } from "../../logger/index.js";
import { getFrameworkConfig } from "../../config/index.js";
import { escapeHtml, stripTrailingSlashes } from "../../utils/string-helpers.js";
import { getOidcDiscovery, type OidcDiscoveryDocument } from "./oauth/discovery.js";
import { OAUTH_FETCH_TIMEOUT_MS } from "./oauth/http.js";
import { GITHUB_ENDPOINTS, GOOGLE_DEFAULT_ISSUER } from "./oauth/presets.js";

const logger = baseLogger.child({ component: "browser-login" });

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_OIDC_SCOPES = ["openid", "profile", "email"] as const;
const DEFAULT_GITHUB_SCOPES = ["read:user", "user:email"] as const;

/** How long a pending browser flow waits for the callback before timing out. */
const DEFAULT_FLOW_TIMEOUT_MS = 10 * 60 * 1000;

const USER_AGENT = "mcp-server-framework";

// ============================================================================
// Types
// ============================================================================

/** Upstream provider kind for the browser login flow. */
export type BrowserOAuthProvider = "oidc" | "github" | "google";

/** Configuration for a single browser login attempt. */
export interface BrowserOAuthConfig {
  /** Upstream provider: a generic OIDC issuer, Google, or GitHub. */
  readonly provider: BrowserOAuthProvider;
  /** OAuth client ID registered with the provider. */
  readonly clientId: string;
  /** OAuth client secret (omit for public PKCE-only clients). */
  readonly clientSecret?: string | undefined;
  /** OIDC issuer URL — REQUIRED when `provider` is `"oidc"`. */
  readonly issuer?: string | undefined;
  /** OAuth scopes; sensible per-provider defaults are used when omitted. */
  readonly scopes?: readonly string[] | undefined;
  /** Public base URL of this server (e.g. `http://localhost:8000`); callback paths are appended. */
  readonly redirectBaseUrl: string;
}

/** Result of a successful browser login. */
export interface BrowserOAuthResult {
  /** Token to present to the downstream service — `id_token` (oidc/google) or `access_token` (github). */
  readonly providerToken: string;
  /** The OIDC ID token, when present (not set for GitHub). */
  readonly idToken?: string;
  /** Validated identity claims (OIDC ID token payload, or GitHub `/user` response). */
  readonly claims: Record<string, unknown>;
}

/** A browser-login handle with a token acquirer and a callback-route registrar. */
export interface BrowserOAuthLogin {
  /** Opens the browser and resolves with the provider token once the callback completes. */
  acquireToken(config: BrowserOAuthConfig): Promise<BrowserOAuthResult>;
  /** Mounts `GET /auth/:provider/callback` routes on the given Express app. */
  registerCallbackRoutes(app: Application): void;
}

// ============================================================================
// Internal flow state
// ============================================================================

interface FlowMetadata {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri?: string | undefined;
}

interface PendingFlow {
  readonly provider: BrowserOAuthProvider;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly metadata: FlowMetadata;
  readonly config: BrowserOAuthConfig;
  readonly resolve: (result: BrowserOAuthResult) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface TokenResponse {
  readonly access_token?: string;
  readonly id_token?: string;
  readonly token_type?: string;
  readonly error?: string;
  readonly error_description?: string;
}

// ============================================================================
// Helpers
// ============================================================================

function base64UrlRandom(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function callbackPath(provider: BrowserOAuthProvider): string {
  return `/auth/${provider}/callback`;
}

function firstQueryValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

/**
 * Derives this server's public base URL from the framework transport config.
 *
 * Reads `MCP_TRANSPORT` (scheme), `MCP_BIND_HOST`, and `MCP_PORT`. A wildcard bind
 * host (`0.0.0.0` / `::`) is reported as `localhost` so the URL is dialable locally.
 *
 * @returns Base URL such as `http://localhost:8000` (no trailing slash)
 */
export function deriveServerBaseUrl(): string {
  const cfg = getFrameworkConfig();
  const scheme = cfg.MCP_TRANSPORT === "https" ? "https" : "http";
  const host = cfg.MCP_BIND_HOST === "0.0.0.0" || cfg.MCP_BIND_HOST === "::" ? "localhost" : cfg.MCP_BIND_HOST;
  return `${scheme}://${host}:${cfg.MCP_PORT}`;
}

/**
 * Opens `url` in the user's default browser — best-effort, never throws.
 *
 * Auto-open is a convenience (the URL is also logged to the terminal), so a
 * missing or failing launcher is swallowed at debug level.
 */
function openBrowser(url: string): void {
  // Launch shell-free (no `shell: true`) with the URL as a single argv element: its `&`
  // separators — and any metacharacters a compromised OIDC provider might inject — must
  // never be parsed by a shell (breaks the URL and opens a command-injection path). One
  // launcher per OS family (`process.platform` is bitness-agnostic — `win32` covers 32-
  // and 64-bit Windows alike): macOS `open`, Windows `rundll32`, else (Linux, *BSD, …)
  // `xdg-open`.
  const [command, args] =
    process.platform === "darwin"
      ? (["open", [url]] as const)
      : process.platform === "win32"
        ? (["rundll32.exe", ["url.dll,FileProtocolHandler", url]] as const)
        : (["xdg-open", [url]] as const);
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch (err) {
    logger.debug("Could not auto-open browser: %s", err instanceof Error ? err.message : String(err));
  }
}

function resultPage(title: string, heading: string, message: string, accent: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f7; }
    .card { background: #fff; padding: 2rem 2.5rem; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,.1);
      max-width: 460px; text-align: center; }
    h1 { color: ${accent}; margin: 0 0 .5rem; font-size: 1.4rem; }
    p { color: #555; margin: .4rem 0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(heading)}</h1>
    <p>${escapeHtml(message)}</p>
    <p>You can close this window and return to your terminal.</p>
  </div>
</body>
</html>`;
}

// ============================================================================
// Provider HTTP
// ============================================================================

async function resolveMetadata(config: BrowserOAuthConfig): Promise<FlowMetadata> {
  if (config.provider === "github") {
    return {
      issuer: "https://github.com",
      authorization_endpoint: GITHUB_ENDPOINTS.authorizationUrl,
      token_endpoint: GITHUB_ENDPOINTS.tokenUrl,
    };
  }

  const issuer = config.provider === "google" ? GOOGLE_DEFAULT_ISSUER : config.issuer?.trim();
  if (!issuer) {
    throw new Error('Browser login with provider "oidc" requires an issuer URL');
  }

  const doc: OidcDiscoveryDocument = await getOidcDiscovery(issuer);
  return {
    issuer: doc.issuer ?? issuer,
    authorization_endpoint: doc.authorization_endpoint,
    token_endpoint: doc.token_endpoint,
    jwks_uri: doc.jwks_uri,
  };
}

async function exchangeCode(flow: PendingFlow, code: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: flow.config.clientId,
    code,
    code_verifier: flow.codeVerifier,
    redirect_uri: flow.redirectUri,
  });
  if (flow.config.clientSecret) {
    body.set("client_secret", flow.config.clientSecret);
  }

  const response = await fetch(flow.metadata.token_endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": USER_AGENT,
    },
    body,
    signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
  });

  const payload = (await response.json()) as TokenResponse;
  if (!response.ok || payload.error) {
    const description = payload.error_description ?? payload.error ?? `${response.status} ${response.statusText}`;
    throw new Error(`Token exchange failed: ${description}`);
  }
  return payload;
}

async function validateIdToken(flow: PendingFlow, idToken: string): Promise<Record<string, unknown>> {
  if (!flow.metadata.jwks_uri) {
    throw new Error("OIDC discovery document did not include a jwks_uri; cannot validate ID token");
  }
  const jwks = createRemoteJWKSet(new URL(flow.metadata.jwks_uri));
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: flow.metadata.issuer,
    audience: flow.config.clientId,
  });
  if (payload.nonce !== flow.nonce) {
    throw new Error("OIDC nonce verification failed");
  }
  return payload;
}

async function validateGitHubToken(accessToken: string): Promise<Record<string, unknown>> {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- optional on UpstreamEndpoints, but GITHUB_ENDPOINTS always defines userinfoUrl.
  const response = await fetch(GITHUB_ENDPOINTS.userinfoUrl!, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": USER_AGENT,
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`GitHub token validation failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Creates a browser-login handle. The returned object owns an internal map of
 * pending flows keyed by `state`, so a single instance must be shared between the
 * `acquireToken` caller and the mounted callback routes.
 *
 * @param options.flowTimeoutMs - How long to wait for the callback (default 10 min)
 * @returns A {@link BrowserOAuthLogin} handle
 */
export function createBrowserOAuthLogin(options?: { readonly flowTimeoutMs?: number }): BrowserOAuthLogin {
  const flowTimeoutMs = options?.flowTimeoutMs ?? DEFAULT_FLOW_TIMEOUT_MS;
  const pendingFlows = new Map<string, PendingFlow>();

  function consumeFlow(state: string): PendingFlow | undefined {
    const flow = pendingFlows.get(state);
    if (!flow) return undefined;
    pendingFlows.delete(state);
    clearTimeout(flow.timer);
    return flow;
  }

  async function completeCallback(provider: BrowserOAuthProvider, query: Record<string, unknown>): Promise<void> {
    const state = firstQueryValue(query["state"]);
    if (!state) {
      throw new Error("Missing OAuth state in callback");
    }
    const flow = consumeFlow(state);
    if (!flow) {
      throw new Error("Unknown or expired OAuth state");
    }
    if (flow.provider !== provider) {
      const err = new Error("OAuth provider mismatch in callback");
      flow.reject(err);
      throw err;
    }

    const error = firstQueryValue(query["error"]);
    if (error) {
      const description = firstQueryValue(query["error_description"]);
      const err = new Error(description ? `${error}: ${description}` : error);
      flow.reject(err);
      throw err;
    }

    const code = firstQueryValue(query["code"]);
    if (!code) {
      const err = new Error("Missing OAuth authorization code");
      flow.reject(err);
      throw err;
    }

    try {
      const tokenResponse = await exchangeCode(flow, code);

      if (flow.provider === "github") {
        if (!tokenResponse.access_token) {
          throw new Error("GitHub token response did not include an access token");
        }
        const claims = await validateGitHubToken(tokenResponse.access_token);
        flow.resolve({ providerToken: tokenResponse.access_token, claims });
        return;
      }

      if (!tokenResponse.id_token) {
        throw new Error("OIDC token response did not include an id_token");
      }
      const claims = await validateIdToken(flow, tokenResponse.id_token);
      flow.resolve({ providerToken: tokenResponse.id_token, idToken: tokenResponse.id_token, claims });
    } catch (err) {
      flow.reject(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  async function acquireToken(config: BrowserOAuthConfig): Promise<BrowserOAuthResult> {
    const metadata = await resolveMetadata(config);
    const redirectUri = `${stripTrailingSlashes(config.redirectBaseUrl)}${callbackPath(config.provider)}`;

    const codeVerifier = base64UrlRandom(48);
    const codeChallenge = pkceChallenge(codeVerifier);
    const state = base64UrlRandom(24);
    const nonce = base64UrlRandom(24);

    const tokenPromise = new Promise<BrowserOAuthResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingFlows.delete(state);
        reject(new Error("Browser login timed out"));
      }, flowTimeoutMs);
      timer.unref();

      pendingFlows.set(state, {
        provider: config.provider,
        nonce,
        codeVerifier,
        redirectUri,
        metadata,
        config,
        resolve,
        reject,
        timer,
      });
    });

    const scopes = config.scopes ?? (config.provider === "github" ? DEFAULT_GITHUB_SCOPES : DEFAULT_OIDC_SCOPES);

    const authUrl = new URL(metadata.authorization_endpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", config.clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("scope", scopes.join(" "));
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    if (config.provider !== "github") {
      authUrl.searchParams.set("nonce", nonce);
    }

    logger.info("Open this URL in your browser to continue authentication:\n%s", authUrl.toString());
    openBrowser(authUrl.toString());

    return tokenPromise;
  }

  function registerCallbackRoutes(app: Application): void {
    const providers: BrowserOAuthProvider[] = ["google", "github", "oidc"];
    for (const provider of providers) {
      app.get(callbackPath(provider), (req: Request, res: Response) => {
        void completeCallback(provider, req.query as Record<string, unknown>)
          .then(() => {
            res
              .status(200)
              .send(
                resultPage(
                  "Authentication Complete",
                  "✓ Authentication successful",
                  "You are now signed in.",
                  "#1a7f37",
                ),
              );
          })
          .catch((err: unknown) => {
            // Log the detail server-side (the CLI where the operator is watching); return a
            // generic page to the browser so upstream error text isn't reflected to the client.
            logger.warn("Browser login callback failed: %s", err instanceof Error ? err.message : String(err));
            res
              .status(400)
              .send(
                resultPage(
                  "Authentication Failed",
                  "✗ Authentication failed",
                  "Sign-in could not be completed. Check the server logs for details.",
                  "#d1242f",
                ),
              );
          });
      });
    }
  }

  return { acquireToken, registerCallbackRoutes };
}
