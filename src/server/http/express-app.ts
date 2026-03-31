/**
 * Express Application Factory
 *
 * Creates and configures the Express application as a security gateway
 * for the MCP server. Express handles routing and security middleware,
 * while MCP protocol handling is fully delegated to the SDK via the
 * StreamableHttpTransport.
 *
 * Layer responsibilities:
 *   Express App:              Security middleware, routing, health checks
 *   StreamableHttpTransport:  Session lifecycle, transport instance management
 *   SDK Transport:            MCP protocol (JSON-RPC, SSE, session headers, Content-Type, Accept)
 *   McpServer:                Business logic (tools, resources, prompts)
 *
 * Security middleware stack (applied at Express level):
 * 1. DNS Rebinding Protection (MUST — not handled by SDK)
 * 2. Rate Limiting (not handled by SDK)
 * 3. Protocol Version Validation (early rejection before SDK)
 *
 * Protocol validation handled by SDK (removed from Express stack):
 * - Content-Type validation
 * - Accept header validation
 * - JSON-RPC structure validation
 *
 * @module server/http/express-app
 */

import express from "express";
import helmet from "helmet";
import cors from "cors";
import { logger as baseLogger } from "../../logger/index.js";

// Session Management
import type { SessionManager } from "../session/index.js";

// Security Middleware (SDK handles Content-Type, Accept, JSON-RPC)
import {
  createRateLimiter,
  validateProtocolVersion,
  dnsRebindingProtection,
  createBearerAuth,
  createCustomHeaderAuth,
} from "../middleware/index.js";

// Auth
import type { AuthOptions, OAuthServerProvider } from "../auth/types.js";
import { isFullOAuthProvider } from "../auth/types.js";

// Routes
import { createHealthRouter, createMetricsRouter, createOAuthRouter } from "../routes/index.js";
import { createStreamableHttpRouter } from "../routes/streamable-http-router.js";
import { createSseRouter, isSseEnabled, getSseSessionCount } from "../routes/sse-router.js";
import { SseRequestHandler } from "../transport/sse/handler.js";
import {
  TRANSPORT_LOG_COMPONENTS,
  TRANSPORT_ROUTES,
  MCP_HEADERS,
  SESSION_ID_QUERY_PARAMS,
} from "../transport/constants.js";
import type { SessionFactory } from "../transport/types.js";
import type { StreamableHttpTransportOptions } from "../transport/streamable-http/index.js";
import type { ReadinessConfig } from "../server-options.js";
import type { EventStore } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const logger = baseLogger.child({
  component: TRANSPORT_LOG_COMPONENTS.HTTP_SERVER,
});

const LogMessages = {
  SSE_ENDPOINTS_MOUNTED: "Mounting SSE endpoints at %s, %s and %s",
  UNHANDLED_MIDDLEWARE_ERROR: "Unhandled Express middleware error: %s",
  CORS_HTTP_CREDENTIALS:
    "CORS credentials enabled with non-localhost HTTP origin(s): %s — credentials over plain HTTP expose tokens to network sniffing",
} as const;

/**
 * Known W3C Content Security Policy directive names.
 * Used to validate user-provided CSP strings against typos and injection.
 * @see https://www.w3.org/TR/CSP3/
 */
const KNOWN_CSP_DIRECTIVES = new Set([
  "default-src",
  "script-src",
  "script-src-elem",
  "script-src-attr",
  "style-src",
  "style-src-elem",
  "style-src-attr",
  "img-src",
  "font-src",
  "connect-src",
  "media-src",
  "object-src",
  "frame-src",
  "child-src",
  "worker-src",
  "manifest-src",
  "prefetch-src",
  "frame-ancestors",
  "form-action",
  "base-uri",
  "navigate-to",
  "sandbox",
  "report-uri",
  "report-to",
  "plugin-types",
  "block-all-mixed-content",
  "upgrade-insecure-requests",
  "require-sri-for",
  "require-trusted-types-for",
  "trusted-types",
]);

// ============================================================================
// Express App Factory
// ============================================================================

/**
 * Options for Express application creation.
 */
export interface ExpressAppOptions {
  /** Operate in stateless mode (no session IDs). Default: false */
  readonly stateless?: boolean | undefined;

  /** Event store for stream resumability (stateful only) */
  readonly eventStore?: EventStore | undefined;

  /** Prefer JSON responses over SSE for simple request-response. Default: true */
  readonly enableJsonResponse?: boolean | undefined;

  /** Readiness endpoint configuration */
  readonly health?: ReadinessConfig | undefined;

  /**
   * Resolved trust proxy value for Express.
   * - `number` for hop count
   * - `string` for IP/CIDR/keyword (possibly comma-separated)
   * - `undefined` when disabled
   */
  readonly trustProxy?: (string | number) | undefined;

  /**
   * CORS allowed origins.
   * - `undefined` — CORS disabled (no Access-Control headers)
   * - `string[]` — List of allowed origins (e.g. `['https://app.example.com']`)
   * - Use `['*']` to allow all origins (not recommended for production)
   */
  readonly corsOrigin?: readonly string[] | undefined;

  /** Allow credentials in CORS requests. Only effective when corsOrigin is set. */
  readonly corsCredentials?: boolean | undefined;

  /** Enable HSTS header. Default: false (managed by reverse proxy) */
  readonly helmetHsts?: boolean | undefined;

  /**
   * Content Security Policy.
   * - `undefined` — Helmet default CSP
   * - `'false'` — Disable CSP
   * - Custom string — CSP directives
   */
  readonly helmetCsp?: string | undefined;

  /**
   * Maximum request body size for `express.json()` middleware.
   * Accepts Express size strings (e.g. `'1mb'`, `'500kb'`, `'2mb'`).
   * @default '1mb'
   */
  readonly bodyLimit?: string | undefined;

  /**
   * X-Frame-Options header.
   * - `'DENY'` — Never allow framing (default)
   * - `'SAMEORIGIN'` — Allow from same origin
   * - `'false'` — Disable X-Frame-Options
   */
  readonly helmetFrameOptions?: ("DENY" | "SAMEORIGIN" | "false") | undefined;

  /**
   * Authentication configuration.
   * When provided, enables OAuth 2.1 endpoints and/or bearer token validation.
   * Health and metrics endpoints remain unauthenticated for probe access.
   */
  readonly auth?: AuthOptions | undefined;
}

// ============================================================================
// Private Setup Helpers
// ============================================================================

/**
 * Configures security headers (Helmet), CORS, and JSON body parser.
 */
function setupSecurityMiddleware(app: express.Application, options?: ExpressAppOptions): void {
  // ── Helmet (Security Headers) ──────────────────────────────────────────
  // Build CSP option
  let cspOption: { directives: Record<string, string[]> } | boolean | undefined;
  if (options?.helmetCsp === "false") {
    cspOption = false;
    logger.warn("Content Security Policy (CSP) is disabled via configuration — this reduces XSS protection");
  } else if (options?.helmetCsp) {
    // Parse directive string: "default-src 'self'; script-src 'none'" → object
    const directives: Record<string, string[]> = {};
    for (const part of options.helmetCsp.split(";")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const [name, ...values] = trimmed.split(/\s+/);
      if (name) {
        if (!KNOWN_CSP_DIRECTIVES.has(name)) {
          logger.warn('Unknown CSP directive "%s" — skipping. Check for typos in MCP_HELMET_CSP.', name);
          continue;
        }
        directives[name] = values;
      }
    }
    cspOption = { directives };
  }

  // Build frameguard option (CWE-693: disabling X-Frame-Options is not allowed)
  const frameguardOption: { action: "deny" | "sameorigin" } =
    options?.helmetFrameOptions === "SAMEORIGIN" ? { action: "sameorigin" } : { action: "deny" };

  app.use(
    helmet({
      strictTransportSecurity: options?.helmetHsts === true ? { maxAge: 15552000, includeSubDomains: true } : false,
      ...(cspOption !== undefined && { contentSecurityPolicy: cspOption }),
      frameguard: frameguardOption,
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    }),
  );

  // ── CORS ────────────────────────────────────────────────────────────────
  if (options?.corsOrigin && options.corsOrigin.length > 0) {
    // CORS spec: credentials=true is invalid with origin='*'
    if (options.corsCredentials && options.corsOrigin.includes("*")) {
      throw new Error(
        'Invalid CORS configuration: credentials cannot be used with wildcard origin "*". ' +
          "Set MCP_CORS_ORIGIN to specific origins when MCP_CORS_CREDENTIALS=true.",
      );
    }

    // Warn about HTTP origins with credentials (tokens exposed to network sniffing)
    if (options.corsCredentials) {
      const insecureOrigins = options.corsOrigin.filter((origin) => {
        try {
          const url = new URL(origin);
          if (url.protocol !== "http:") return false;
          const host = url.hostname;
          return host !== "localhost" && host !== "127.0.0.1" && host !== "::1";
        } catch {
          return false;
        }
      });
      if (insecureOrigins.length > 0) {
        logger.warn(LogMessages.CORS_HTTP_CREDENTIALS, insecureOrigins.join(", "));
      }
    }

    const origin = options.corsOrigin.includes("*") ? "*" : [...options.corsOrigin];
    app.use(
      cors({
        origin,
        credentials: options.corsCredentials ?? false,
      }),
    );
  }

  app.use(express.json({ limit: options?.bodyLimit ?? "1mb" }));
}

/**
 * Validates a redirect_uri for OAuth auto-registration.
 *
 * Rejects dangerous URI schemes (javascript:, data:, file:, etc.) and
 * ensures only http: (localhost only) or https: are accepted.
 * This prevents open-redirect attacks (CWE-601) and XSS via crafted URIs.
 *
 * @returns `true` if the URI is safe, `false` otherwise
 */
function isValidRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }

  // Only allow http: for localhost (development) and https: for everything else
  if (parsed.protocol === "http:") {
    const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
    return isLocalhost;
  }

  return parsed.protocol === "https:";
}

/**
 * Creates middleware that auto-registers unknown OAuth clients at /authorize.
 *
 * Handles two common scenarios:
 * 1. Clients that skip Dynamic Client Registration (e.g., VS Code with cached credentials)
 * 2. Stale client_ids after server restart (in-memory store cleared)
 *
 * Security constraints:
 * - redirect_uri must use https: (or http: for localhost only)
 * - Dangerous schemes (javascript:, data:, file:) are rejected
 * - This is safe because /register already allows open registration — this middleware
 *   does the same thing lazily. The SDK authorize handler then finds the client and
 *   proceeds normally.
 */
function createClientAutoRegistration(provider: OAuthServerProvider): express.RequestHandler {
  return async (req, _res, next) => {
    try {
      const clientId = req.query.client_id as string | undefined;
      const redirectUri = req.query.redirect_uri as string | undefined;

      if (!clientId || !redirectUri || !provider.clientsStore.registerClient) {
        next();
        return;
      }

      // Validate redirect_uri scheme to prevent open-redirect attacks (CWE-601)
      if (!isValidRedirectUri(redirectUri)) {
        logger.warn("Rejected auto-registration for client %s: invalid redirect_uri scheme", clientId);
        next();
        return;
      }

      const existing = await provider.clientsStore.getClient(clientId);

      if (!existing) {
        // Unknown client — auto-register with the requested redirect_uri
        // @type-narrowing: constructing minimal OAuthClientInformationFull
        await provider.clientsStore.registerClient({
          client_id: clientId,
          redirect_uris: [redirectUri],
          client_id_issued_at: Math.floor(Date.now() / 1000),
        } as Parameters<typeof provider.clientsStore.registerClient>[0]);
        logger.info("Auto-registered unknown client %s at /authorize", clientId);
      } else if (!existing.redirect_uris.includes(redirectUri)) {
        // Known client but new redirect_uri (e.g., VS Code with different port) — update
        await provider.clientsStore.registerClient({
          ...existing,
          redirect_uris: [...existing.redirect_uris, redirectUri],
        });
        logger.debug("Updated client %s redirect_uris at /authorize", clientId);
      }
    } catch (err) {
      // Non-fatal — let the SDK handler deal with the original request
      logger.debug("Client auto-registration failed: %s", err instanceof Error ? err.message : "unknown error");
    }
    next();
  };
}

/**
 * Mounts MCP transport routes: Legacy SSE, security middleware stack,
 * SSE fallback on /mcp, and Streamable HTTP router.
 */
function setupMcpRoutes(
  app: express.Application,
  sessionFactory: SessionFactory,
  sessionManager: SessionManager,
  options?: ExpressAppOptions,
): void {
  // ===== Legacy SSE Transport Routes (optional) =====
  // Mount BEFORE the MCP middleware stack to avoid Streamable HTTP validation
  // Deprecated HTTP+SSE transport from protocol 2024-11-05
  if (isSseEnabled()) {
    logger.trace(
      LogMessages.SSE_ENDPOINTS_MOUNTED,
      TRANSPORT_ROUTES.MCP_MESSAGE,
      TRANSPORT_ROUTES.SSE,
      TRANSPORT_ROUTES.SSE_MESSAGE,
    );
  }
  // Always mount the router — returns 501 if feature is disabled
  // Apply DNS rebinding protection to SSE routes (MCP spec MUST requirement)
  app.use([TRANSPORT_ROUTES.SSE, TRANSPORT_ROUTES.SSE_MESSAGE, TRANSPORT_ROUTES.MCP_MESSAGE], dnsRebindingProtection);
  app.use(createSseRouter(sessionFactory, sessionManager));

  // ===== MCP Transport Routes =====
  // Streamable HTTP transport on /mcp endpoint
  // Security middleware (Express level — not handled by SDK)
  app.use(TRANSPORT_ROUTES.MCP, dnsRebindingProtection); // 1. DNS Rebinding Protection (MUST)
  app.use(
    TRANSPORT_ROUTES.MCP,
    createRateLimiter({
      trustProxyConfigured: options?.trustProxy !== undefined,
    }),
  ); // 2. Rate Limiting (before auth to mitigate brute-force, CWE-770)

  // 3. Bearer Auth / Custom Header Auth (only when auth is configured)
  if (options?.auth) {
    if (options.auth.headerName && !isFullOAuthProvider(options.auth.provider)) {
      // Custom header auth (e.g. X-API-Key) — only with TokenVerifier
      app.use(
        TRANSPORT_ROUTES.MCP,
        createCustomHeaderAuth({
          headerName: options.auth.headerName,
          verifier: options.auth.provider,
          requiredScopes: options.auth.requiredScopes,
        }),
      );
    } else {
      // Auto-derive resourceMetadataUrl from issuerUrl when using a full OAuth provider (RFC 9728)
      const resourceMetadataUrl =
        options.auth.resourceMetadataUrl ??
        (isFullOAuthProvider(options.auth.provider) && options.auth.issuerUrl
          ? `${options.auth.issuerUrl.origin}/.well-known/oauth-protected-resource`
          : undefined);

      // Standard Bearer auth (OAuth or TokenVerifier without custom header)
      app.use(
        TRANSPORT_ROUTES.MCP,
        createBearerAuth({
          provider: options.auth.provider,
          requiredScopes: options.auth.requiredScopes,
          resourceMetadataUrl,
        }),
      );
    }
  }

  app.use(TRANSPORT_ROUTES.MCP, validateProtocolVersion); // 4. Protocol Version (early rejection)
  // Note: Content-Type, Accept, and JSON-RPC validation are handled by the SDK
  // transport internally — no need to duplicate here.

  // ===== Legacy SSE Fallback on /mcp (behind security middleware) =====
  // Intercepts GET /mcp with Accept: text/event-stream and no session ID.
  // Must be BEFORE the Streamable HTTP router so legacy SSE clients are handled
  // before the SDK transport sees the request.
  if (isSseEnabled()) {
    const sseHandler = new SseRequestHandler(sessionFactory, sessionManager);
    app.get(TRANSPORT_ROUTES.MCP, (req, res, next) => {
      const hasSession = req.headers[MCP_HEADERS.SESSION_ID] || SESSION_ID_QUERY_PARAMS.some((p) => req.query[p]);
      const wantsSSE = (req.headers.accept || "").includes("text/event-stream");

      if (!hasSession && wantsSSE) {
        void sseHandler.handleConnection(req, res, TRANSPORT_ROUTES.MCP_MESSAGE);
      } else {
        next();
      }
    });
  }

  // MCP route handler — delegates to SDK via StreamableHttpTransport
  const handlerOptions: StreamableHttpTransportOptions = {
    stateless: options?.stateless,
    eventStore: options?.eventStore,
    enableJsonResponse: options?.enableJsonResponse,
  };
  app.use(TRANSPORT_ROUTES.MCP, createStreamableHttpRouter(sessionFactory, sessionManager, handlerOptions));
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Creates and configures the Express application.
 *
 * The returned app is fully configured with security middleware
 * and route handlers. MCP protocol validation (Content-Type, Accept,
 * JSON-RPC) is delegated to the SDK transport via StreamableHttpTransport.
 *
 * @param sessionFactory - Factory to create McpSession instances
 * @param sessionManager - Unified session manager (owned by McpServer)
 * @param options - Application configuration options
 * @returns Configured Express application
 */
export function createExpressApp(
  sessionFactory: SessionFactory,
  sessionManager: SessionManager,
  options?: ExpressAppOptions,
): express.Application {
  const app = express();

  // Trust Proxy — must be set BEFORE any middleware that reads req.ip or req.protocol
  if (options?.trustProxy !== undefined) {
    app.set("trust proxy", options.trustProxy);
  }

  setupSecurityMiddleware(app, options);

  // ===== OAuth Router (before health routes, needs express.json()) =====
  if (options?.auth && isFullOAuthProvider(options.auth.provider)) {
    if (!options.auth.issuerUrl) {
      throw new Error("issuerUrl is required when using a full OAuth provider");
    }

    // Auto-register unknown clients at /authorize (before SDK router handles it).
    // Handles clients with cached credentials that skip /register.
    app.get("/authorize", createClientAutoRegistration(options.auth.provider));

    app.use(
      createOAuthRouter({
        provider: options.auth.provider,
        issuerUrl: options.auth.issuerUrl,
        scopesSupported: options.auth.requiredScopes,
      }),
    );

    // Optional callback handler for server-side OAuth callbacks
    // (e.g., GitHub redirects back to MCP server, not directly to client)
    if (options.auth.callbackHandler) {
      app.get("/callback", options.auth.callbackHandler);
    }
  }

  // ===== Health & Metrics Routes (exempt from auth and rate limiting) =====
  app.use(
    createHealthRouter({
      sessionManager,
      readinessCheck: options?.health?.readinessCheck,
      serviceLabel: options?.health?.serviceLabel,
      sseInfo: {
        enabled: isSseEnabled(),
        getSessionCount: getSseSessionCount,
      },
    }),
  );
  app.use(createMetricsRouter());

  setupMcpRoutes(app, sessionFactory, sessionManager, options);

  // ===== Global Error Handler (must be LAST) =====
  // Express identifies error handlers by the 4-parameter signature.
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error(LogMessages.UNHANDLED_MIDDLEWARE_ERROR, err.stack ?? err.message);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
      });
    }
  });

  return app;
}
