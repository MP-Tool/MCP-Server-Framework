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
  createAuthMiddleware,
  apiAccessLog,
} from "../middleware/index.js";

// Auth
import type { AuthOptions, OAuthServerProvider } from "../auth/types.js";
import { isFullOAuthProvider } from "../auth/types.js";
import { parseClientRedirectUri } from "../auth/oauth/http.js";

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
 * Dedicated low-capacity limits for the OAuth endpoints (`/authorize`, `/token`, …),
 * separate from the MCP transport limiter, to slow credential brute-forcing (CWE-307).
 */
const AUTH_RATE_LIMIT_MAX = 30;
const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

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

  /**
   * Enable HSTS header (tri-state).
   * - `true`/`false` — force on/off
   * - `undefined` — defaults to `tlsTerminated` (on when the framework terminates TLS)
   */
  readonly helmetHsts?: boolean | undefined;

  /**
   * Whether the framework itself terminates TLS (`transport.mode: "https"`), as opposed to
   * plain HTTP or HTTPS fronted by a reverse proxy. Drives the HSTS default when `helmetHsts`
   * is unset — the header only makes sense on a connection the framework serves over TLS.
   */
  readonly tlsTerminated?: boolean | undefined;

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

  /**
   * Optional hook to register additional Express routes on the app.
   *
   * Runs after global security headers (Helmet/CORS/JSON) and the OAuth router,
   * but **before** health, metrics, and MCP transport routes are mounted.
   *
   * Security scope: DNS-rebinding protection, rate limiting, and auth middleware
   * are all scoped to `/mcp` only — they do NOT apply to routes registered here.
   * Consumer is responsible for authenticating and protecting any routes added
   * via this hook.
   */
  readonly configureApp?: ((app: express.Application) => void) | undefined;
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
  let cspOption: boolean | { directives: Record<string, string[]> } | undefined;
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
    if (!directives["form-action"]) {
      logger.warn(
        "Custom CSP (MCP_HELMET_CSP) does not include 'form-action' — login form submissions are unrestricted. " +
          "Add \"form-action 'self'\" to restrict submissions to the same origin.",
      );
    }
    cspOption = { directives };
  } else {
    // No custom CSP — use Helmet defaults, ensuring form-action 'self' is present. Without
    // it, browsers allow form submissions to any origin, enabling login CSRF (attacker page
    // submits credentials cross-origin to /authorize/local). Conditional rather than always
    // spreading it in: depending on the installed Helmet version, the defaults may already
    // include form-action — adding it again unconditionally makes Helmet throw ("duplicate
    // directive"), since it treats the kebab-case and camelCase spellings as the same directive.
    // getDefaultDirectives() returns string-array values at runtime; cast is safe.
    const defaultDirectives = helmet.contentSecurityPolicy.getDefaultDirectives() as Record<string, string[]>;
    cspOption = {
      directives:
        "form-action" in defaultDirectives ? defaultDirectives : { ...defaultDirectives, formAction: ["'self'"] },
    };
  }

  // Build frameguard option. 'false' disables X-Frame-Options (not recommended).
  const frameguardOption: { action: "deny" | "sameorigin" } | false =
    options?.helmetFrameOptions === "SAMEORIGIN"
      ? { action: "sameorigin" }
      : options?.helmetFrameOptions === "false"
        ? false
        : { action: "deny" };

  // HSTS is tri-state: honor an explicit setting, otherwise default it to whether the
  // framework itself terminates TLS. Sending Strict-Transport-Security only makes sense on
  // a connection we serve over HTTPS; on plain HTTP it is ignored by browsers, and behind a
  // TLS-terminating proxy the proxy owns the header.
  const hstsEnabled = options?.helmetHsts ?? options?.tlsTerminated ?? false;

  app.use(
    helmet({
      strictTransportSecurity: hstsEnabled ? { maxAge: 15552000, includeSubDomains: true } : false,
      contentSecurityPolicy: cspOption,
      ...(frameguardOption !== false ? { frameguard: frameguardOption } : { frameguard: false }),
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    }),
  );

  // Warn when the framework terminates TLS but HSTS is nonetheless off (operator set it to
  // false explicitly) — the HTTPS connection then ships no Strict-Transport-Security header,
  // leaving clients open to SSL-strip on later visits.
  if (!hstsEnabled && options?.tlsTerminated) {
    logger.warn(
      "HSTS (Strict-Transport-Security) is disabled while the server terminates TLS. " +
        "Remove MCP_HELMET_HSTS=false to enable it, or ensure an upstream sets the header.",
    );
  }

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
        // Let browser MCP clients read the session ID the SDK returns on initialize —
        // without this it is hidden by the CORS response-header allowlist, so a cross-origin
        // browser client cannot establish a stateful session.
        exposedHeaders: [MCP_HEADERS.SESSION_ID],
      }),
    );
  }

  app.use(express.json({ limit: options?.bodyLimit ?? "1mb" }));
}

/**
 * Validates a redirect_uri for OAuth auto-registration.
 *
 * Delegates to {@link parseClientRedirectUri} so auto-registration and the OAuth
 * callback share one definition of an acceptable redirect target: HTTPS (any host),
 * HTTP on loopback only, or a private-use URI scheme (RFC 8252 §7.1). Dangerous
 * schemes (`javascript:`, `data:`, `file:`, …) are rejected. This prevents
 * open-redirect attacks (CWE-601) and XSS via crafted URIs.
 *
 * @returns `true` if the URI is safe, `false` otherwise
 */
function isValidRedirectUri(uri: string): boolean {
  return parseClientRedirectUri(uri) !== null;
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
/** Maximum redirect_uris stored per client — prevents unbounded accumulation (CWE-770). */
const MAX_REDIRECT_URIS_PER_CLIENT = 20;

function createClientAutoRegistration(provider: OAuthServerProvider): express.RequestHandler {
  return async (req, _res, next) => {
    try {
      // typeof narrowing instead of a cast — Express yields an array for
      // repeated query params (?client_id=a&client_id=b), which a plain
      // `as string` would let through unchecked.
      const clientId = typeof req.query.client_id === "string" ? req.query.client_id : undefined;
      const redirectUri = typeof req.query.redirect_uri === "string" ? req.query.redirect_uri : undefined;

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
        logger.debug("Auto-registered unknown client %s at /authorize", clientId);
      } else if (!existing.redirect_uris.includes(redirectUri)) {
        if (existing.redirect_uris.length >= MAX_REDIRECT_URIS_PER_CLIENT) {
          logger.warn(
            "Rejected redirect_uri update for client %s: limit of %d reached",
            clientId,
            MAX_REDIRECT_URIS_PER_CLIENT,
          );
        } else {
          // Known client but new redirect_uri (e.g., VS Code with different port) — update
          await provider.clientsStore.registerClient({
            ...existing,
            redirect_uris: [...existing.redirect_uris, redirectUri],
          });
          logger.debug("Updated client %s redirect_uris at /authorize", clientId);
        }
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

  // ── Build auth middleware once — shared by SSE routes and /mcp ─────────────
  // Building it once avoids duplicating the construction logic for two route groups.
  let sharedAuthMiddleware: ReturnType<typeof createAuthMiddleware> | undefined;
  if (options?.auth && options.auth.enabled !== false) {
    const { provider, headerName, requiredScopes, onAuthenticated } = options.auth;
    if (headerName !== undefined && headerName === "") {
      logger.warn(
        "AuthOptions.headerName is an empty string — falling back to Bearer auth. Set a non-empty header name or remove the option.",
      );
    }
    const useCustomHeader = headerName !== undefined && headerName !== "" && !isFullOAuthProvider(provider);
    // Resource Metadata URL (RFC 9728) is always auto-derived from the issuer origin for full
    // OAuth providers (the issuer comes from the public base URL, MCP_BASE_URL); N/A for custom headers.
    const resourceMetadataUrl =
      !useCustomHeader && isFullOAuthProvider(provider) && options.auth.issuerUrl
        ? `${options.auth.issuerUrl.origin}/.well-known/oauth-protected-resource`
        : undefined;
    sharedAuthMiddleware = createAuthMiddleware({
      provider,
      ...(useCustomHeader && headerName ? { tokenSource: { header: headerName } } : {}),
      requiredScopes,
      resourceMetadataUrl,
      onAuthenticated,
    });
  }

  // Single shared rate limiter for all MCP transport routes (SSE + /mcp).
  // One instance = one shared bucket per client IP — prevents bypassing the
  // limit by splitting requests between endpoints (CWE-770).
  const mcpRateLimiter = createRateLimiter({ trustProxyConfigured: options?.trustProxy !== undefined });

  // ── SSE routes: DNS rebinding + rate limiting + auth ───────────────────────
  // Always mounted — returns 501 when SSE is disabled (ensures DNS rebinding protection).
  const sseRoutes = [TRANSPORT_ROUTES.SSE, TRANSPORT_ROUTES.SSE_MESSAGE, TRANSPORT_ROUTES.MCP_MESSAGE];
  app.use(sseRoutes, dnsRebindingProtection); // 1. DNS Rebinding Protection (MUST)
  app.use(sseRoutes, mcpRateLimiter); // 2. Rate Limiting (shared bucket with /mcp)
  if (sharedAuthMiddleware) {
    app.use(sseRoutes, sharedAuthMiddleware); // 3. Auth (when configured)
  }
  app.use(createSseRouter(sessionFactory, sessionManager));

  // ===== MCP Transport Routes =====
  // Streamable HTTP transport on /mcp endpoint
  // Security middleware (Express level — not handled by SDK)
  app.use(TRANSPORT_ROUTES.MCP, dnsRebindingProtection); // 1. DNS Rebinding Protection (MUST)
  app.use(TRANSPORT_ROUTES.MCP, mcpRateLimiter); // 2. Rate Limiting (shared bucket with SSE routes)
  if (sharedAuthMiddleware) {
    app.use(TRANSPORT_ROUTES.MCP, sharedAuthMiddleware); // 3. Auth (when configured)
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

  // API Access Log — mounted first so every request is captured, including ones
  // later rejected by DNS-rebinding protection, auth, or rate limiting.
  app.use(apiAccessLog);

  setupSecurityMiddleware(app, options);

  // ===== OAuth Router (before health routes, needs express.json()) =====
  if (options?.auth && options.auth.enabled !== false && isFullOAuthProvider(options.auth.provider)) {
    if (!options.auth.issuerUrl) {
      throw new Error("issuerUrl is required when using a full OAuth provider");
    }

    // Dedicated low-capacity rate limiter for auth endpoints (see constants above).
    const authRateLimiter = createRateLimiter({
      max: AUTH_RATE_LIMIT_MAX,
      windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
      // options is narrowed to defined by the enclosing `if (options?.auth && …)`.
      trustProxyConfigured: options.trustProxy !== undefined,
    });
    const oauthRoutes = ["/authorize", "/token", "/register", "/callback", "/authorize/local"];
    app.use(oauthRoutes, dnsRebindingProtection); // DNS Rebinding Protection on all auth endpoints
    app.use(oauthRoutes, authRateLimiter);

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

    // Optional local username/password login (unified login page → isolated session).
    // Needs urlencoded form-body parsing for the POSTed credentials.
    if (options.auth.localLoginHandler) {
      app.post("/authorize/local", express.urlencoded({ extended: false }), options.auth.localLoginHandler);
    }
  }

  // ===== Consumer App Customization Hook =====
  if (options?.configureApp) {
    options.configureApp(app);
  }

  // ===== Health & Metrics Routes (exempt from auth and rate limiting) =====
  app.use(
    createHealthRouter({
      sessionManager,
      readinessCheck: options?.health?.readinessCheck,
      checkTimeoutMs: options?.health?.checkTimeoutMs,
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
