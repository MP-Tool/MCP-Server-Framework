# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.0]

### Added

- **`title?`/`icons?` on `CreateServerOptions` / `ServerOptions` — MCP-spec server branding**:
  Threaded through to the SDK's `Implementation` object returned during `initialize`, so MCP
  clients can display a human-friendly name and icon distinct from the machine-readable `name`.
  Added `iconFromFile(filePath, mimeType, options?)` (new: `mcp-server-framework`) as a reusable
  primitive — reads a local image file synchronously and returns an `Icon` with the bytes embedded
  as a base64 `data:` URI, which works identically across stdio and HTTP transports since the icon
  travels inline in the JSON-RPC response (no separate asset serving needed). Files over 1 MB are
  rejected with a `ConfigurationError` — the encoded icon is embedded in every `initialize`
  response, so an oversized file (e.g. a mistaken path) would bloat every session handshake.
  `Icon`/`Icons` re-exported from the SDK for consumers building entries by hand.
- **`configureHttpApp?: (app: Application) => void` on `CreateServerOptions` / `ServerOptions`**:
  Optional hook to register additional Express routes on the MCP HTTP server. Runs after base
  security middleware (Helmet, DNS rebinding, rate limiting) and before health, metrics, and MCP
  transport routes are mounted. Useful for OAuth callback endpoints (`/auth/google/callback`),
  custom health routes, or any server-side HTTP handler that shares the MCP host. Ignored in
  stdio mode.
- **`AuthContext`, `createAuthContext`, `ANONYMOUS_AUTH`** exported from the main package: The
  auth context type and its factory are now part of the public API. `ANONYMOUS_AUTH` is the
  canonical unauthenticated context sentinel. Previously these were only accessible via internal
  subpaths.
- **`onClientConnected` receives `auth?: AuthContext`**: The `ServerLifecycleHooks.onClientConnected`
  callback now receives the session's `AuthContext` as an optional second argument. Populated
  whenever `options.auth` is configured and the session was established with a valid token;
  `undefined` for unauthenticated sessions or stdio mode. Existing zero-argument / one-argument
  callbacks continue to work unchanged.

- **`createOAuthProvider(config | config[], options)` — unified OAuth provider factory**: Replaces the two
  separate factories (`createUpstreamOAuthProvider`, `createOidcProvider`). Config is a discriminated
  union on `type`: `"github" | "google" | "oidc" | "oauth2"`. GitHub and Google require only a
  `clientId`/`clientSecret`; `"oidc"` performs automatic endpoint discovery from the issuer URL;
  `"oauth2"` is the explicit-endpoints escape hatch for arbitrary providers. Pass an array of configs to
  enable multi-provider mode — users see an auto-rendered provider-selection page when no `?provider=`
  parameter is present.
- **`ProviderContext` hook context**: `mapUserInfo` and `onTokenExchanged` now receive a `ProviderContext`
  (`{ type, name, issuer? }`) as their first argument. `ctx.type` is a stable discriminant for switch
  statements; `ctx.name` is the unique routing key. This fixes a latent bug where the internal
  `oidc:<issuer>` routing name leaked into hook arguments when using `createOidcProvider`.
- **`authInfoExpiry(ttlSeconds?, nowMs?)` helper**: Returns a correctly-shaped expiry timestamp in epoch
  seconds, compatible with the SDK's bearer-auth token validation. Exported from the main package.
- **New types**: `OAuthProviderConfig`, `GithubProviderConfig`, `GoogleProviderConfig`,
  `OidcProviderConfig`, `OAuth2ProviderConfig`, `CreateOAuthProviderOptions`, `OAuthProviderResult`,
  `OAuthProviderType`, `ProviderContext`, `MapUserInfo`, `OnTokenExchanged` — all exported from the main
  package for fully typed consumer configuration.

- **`createAuthMiddleware(options)` — unified auth middleware**: Replaces `createBearerAuth` and
  `createCustomHeaderAuth` with a single factory driven by two orthogonal options. `tokenSource`
  controls where the token is read from (`"bearer"` for `Authorization: Bearer` or
  `{ header: "X-API-Key" }` for a custom header). `enforcement` controls what happens on
  missing/invalid tokens: `"required"` (default) rejects with 401/403; `"optional"` calls
  `next()` without setting `req.auth`, allowing anonymous access alongside authenticated
  requests from one route definition. The `required` + `bearer` combination delegates to the
  SDK's `requireBearerAuth` to keep RFC 6750 / RFC 9728 `WWW-Authenticate` discovery intact.
- **`extractBearerToken(authHeader)` helper**: Extracts the token string from a well-formed
  `Authorization: Bearer <token>` header value. Returns `undefined` for missing, malformed, or
  non-Bearer headers. Exported from the main package.
- **`onAuthenticated` hook on `AuthMiddlewareOptions`**: Optional async callback invoked after
  successful token verification. Its return value is merged into `req.auth.extra`, making
  consumer-specific context (user ID, role, tenant) available to route handlers without a
  separate middleware. Hook errors are logged and swallowed — a failing hook never rejects a
  valid session.
- **`AuthTokenSource`, `AuthEnforcement`, `AuthMiddlewareOptions`**: New types exported from
  the main package for typed middleware configuration.

- **`ReadinessConfig.checkTimeoutMs` / `HealthRouterOptions.checkTimeoutMs`**: Bounds how long
  `/ready` waits for a consumer-provided `readinessCheck()` before returning `503`. Prevents a
  stalled dependency (e.g. a hung DB connection) from blocking the endpoint indefinitely and
  delaying Graceful Shutdown. Defaults to `5000`ms. The deadline timer is cleared as soon as the
  check settles — readiness probes fire frequently (container orchestrators poll every few
  seconds), so a lingering timer per probe would accumulate and delay process exit on shutdown.
- **HTTPS server enforces a TLS 1.2 floor**: `startHttpsServer()` now sets `minVersion: "TLSv1.2"`
  on the TLS context, rejecting legacy TLS 1.0/1.1 handshakes.
- **`resolveAuthConfig()` + `toOAuthProviderConfigs()` — declarative `[auth]` config-file support**:
  Turns a config-file `[auth]` section (master switch + a `[auth.providers.<name>]` table) into the
  `OAuthProviderConfig[]` consumed by `createOAuthProvider`, plus the resolved `enabled` flag and
  `/mcp` enforcement metadata. The master switch honours `MCP_AUTH_ENABLED` (env var or `.env` file —
  now resolved through `getFrameworkConfig()`, like every other framework env var, instead of reading
  `process.env` directly) → `[auth].enabled` (file) → an optional `resolveAuthConfig({ defaultEnabled })`
  argument → "enabled when at least one provider is configured". The `defaultEnabled` override lets a
  consumer with a non-provider login method (e.g. local username/password) default auth *on* even with
  zero OAuth providers configured, without changing the framework's own default for other consumers.
  Provider entries accept `id`/`secret` aliases alongside `client_id`/`client_secret` and infer `type`
  from the table key when omitted. Exposed via `ResolvedAuthConfig`, `AuthProviderInput`.
- **`AuthOptions.enabled` — master switch for authentication**: When `false`, the framework mounts
  neither the auth middleware nor the OAuth routes on any transport route (SSE and `/mcp` share the
  same auth middleware instance now, built once). Treated as `true` when omitted. Lets a consumer
  pass a fully-resolved auth config but keep it inert, and guards against accidentally serving
  authenticated routes when auth was meant to be off.
- **`localLogin` — username/password login alongside OAuth on the unified login page**: Configure a
  `verify(username, password)` callback on `CreateOAuthProviderOptions.localLogin`; a successful
  verification mints a session through the same authorization-code/PKCE machinery as an OAuth login,
  so a local login is exactly as isolated as an OAuth one. May be the only login method (no OAuth
  providers required). Mounted at `POST /authorize/local` (via `AuthOptions.localLoginHandler`).
- **`renderLoginPage` — custom login page branding**: Pass a `LoginPageRenderer` (`renderSelectionPage`
  / `renderSuccessRedirectPage`) to `createOAuthProvider` to replace the framework's generic,
  neutral-themed (light/dark) login page with an application-branded one. Exposed via
  `LoginPageRenderer`, `SelectableProvider`, `LocalLoginForm`.
- **`createBrowserOAuthLogin()` — interactive browser OAuth/OIDC login**: A generic
  Authorization-Code-with-PKCE flow for stdio-mode servers (or any server needing the operator to
  log in via a browser). Supports a generic OIDC issuer, Google, and GitHub; reuses the framework's
  cached, SSRF-guarded `getOidcDiscovery()`. Returns the validated upstream provider token
  (OIDC/Google `id_token` or GitHub `access_token`) with its identity claims — no token minting or
  consumer-specific credential mapping baked in. `registerCallbackRoutes(app)` mounts the
  `GET /auth/:provider/callback` handlers (designed for the `configureHttpApp` hook). Exposed via
  `BrowserOAuthLogin`, `BrowserOAuthConfig`, `BrowserOAuthResult`, `BrowserOAuthProvider`.
- **`deriveServerBaseUrl()` helper**: Computes this server's public base URL from the transport
  config (`MCP_TRANSPORT`/`MCP_BIND_HOST`/`MCP_PORT`), rewriting a wildcard bind host to `localhost`.
- **`jwks_uri` on `OidcDiscoveryDocument`**: The discovery document now carries the provider's JWKS
  URI, enabling ID-token signature validation.
- **`defineAuthExtra<T>(guard)` — typed `auth.extra` binding**: A small read/write codec for the
  consumer-defined `extra` payload carried on `AuthInfo` / `AuthContext` / `ToolContext.auth`.
  Replaces ad-hoc `auth.extra["x"] as string` casts and reads uniformly across stateful
  (`session.auth`) and stateless (`ToolContext.auth`) contexts. Exposed via `AuthExtraBinding`,
  `HasAuthExtra`.
- **`createIdentityStore<T>(options)` + `authIdentityKey(auth)` — identity-scoped binding**: A
  get-or-create cache keyed by a stable user identity, for binding per-user state (e.g. a downstream
  service connection) and reusing it across requests in **both stateful and stateless** transports.
  Concurrent creates for one key share a single in-flight factory; entries fall out via idle TTL, LRU
  cap, and explicit `evict()` (with an `onDispose` hook). `authIdentityKey()` derives a stable key
  from an `AuthContext` or `ToolContext.auth`. Exposed via `IdentityStore`, `IdentityStoreOptions`,
  `AuthIdentitySource`.
- **`getCurrentToolContext()` — AsyncLocalStorage-backed tool context accessor**: Returns the
  `ToolContext` for the currently executing tool call from anywhere in the call stack (helpers,
  connection managers, etc.) without threading it through as a parameter. `undefined` outside a tool
  handler.
- **Acting user identity in log output**: `LogContext.user` (human-readable username/email) is now
  shown in the text-formatter log prefix (`u:<user>`). Tool execution derives it from the
  conventional `username` field on `auth.extra`, falling back to the token's `clientId`.
- **`ToolContext.auth.extra` is now populated for stateless tool calls**: previously hardcoded to
  `undefined`; now carries the same `onAuthenticated`-hook result as `session.auth.extra` does for
  stateful sessions.
- **Observability parity for task tools**: `createTask`/`getTask`/`getTaskResult` are now wrapped in
  the same tracing span, request-duration metric, and debug/error logging as regular tool calls —
  previously only synchronous tools had this instrumentation.
- **`logAuditEvent()` — parallel JSON-Lines audit trail, on by default**: A security/activity log
  written to a dedicated file (one JSON object per line), in parallel to the normal application logs
  and independent of `LOG_LEVEL`. `MCP_AUDIT_FILE` (or `[logging].audit_file`) overrides the
  destination; when unset, events land in `<LOG_DIR or the framework's default log dir>/audit.log`
  (see `resolveAuditFilePath()`) — the trail is always active, not opt-in. Emitted for tool calls
  (`tool.call`), session lifecycle (`session.open`/`session.close`), and security events (denied
  auth, DNS-rebinding rejections, rate-limit hits). Exposed via `AuditEvent`, `AuditActor`,
  `AuditCategory`, `AuditOutcome`, `resolveAuditFilePath`.
- **`createInMemoryEventStore()` — bounded `EventStore` for stream resumability**: Replaces the
  re-export of the SDK's example `InMemoryEventStore`, which the SDK itself documents as "not for
  production use": it never evicts anything (unbounded memory growth), replays by sorting *every*
  event ever stored across *all* streams on every reconnect, and recovers a stream ID by splitting
  the event ID on `_` — which silently breaks for the SDK's own standalone GET SSE stream (whose ID
  is the literal string `_GET_stream`). The framework's implementation keeps one bounded,
  insertion-ordered event log per stream plus a flat event-to-stream index, so replay only touches
  the relevant stream (O(events since `lastEventId`), not a global sort) and no ID is ever parsed.
  Bounded by `maxEventsPerStream` and `maxStreams` (oldest/least-recently-written evicted first,
  default 1000 each) plus an idle `ttlMs` sweep (default 5 minutes). Exposed via
  `InMemoryEventStoreOptions`, `InMemoryEventStoreResult`. **Breaking rename** for existing
  consumers: replace `new InMemoryEventStore()` (from the SDK's `examples/` path) with
  `createInMemoryEventStore()` (from `mcp-server-framework`). Messages are stored by value
  (`structuredClone`), so later mutation of a caller's message object can never alter what a
  replay delivers. `evictStreams(predicate)` supports bulk eviction (used by the framework to
  reclaim a closed session's streams promptly, see below). `dispose()` stops the idle-sweep
  timer and is now called automatically on server shutdown when `transport.eventStore` was
  provided.
- **`apiAccessLog` middleware — HTTP access logging**: Logs one line per request (method, path,
  status, duration) to the `"api"` file-log component — previously an empty, unused stream slot
  (`api.log` alongside `server.log`, both created eagerly but only `server.log` was ever written
  to). Mounted first in the Express pipeline, so requests rejected later by DNS-rebinding
  protection, auth, or rate limiting are still captured. Also populates the existing `HttpContext`
  (`method`/`path`/`statusCode`/`durationMs`) for JSON-format consumers. Deliberately separate
  from `logAuditEvent()`/`audit.log` — mirroring all traffic there, including health/metrics
  polling, would flood the audit trail with low-value noise. Query strings are never logged (OAuth
  flows carry `code`/`state` there). Internal middleware, automatically applied — not part of the
  public API surface.

### Dependencies

- Added **`jose`** (`^6.2.3`) for OIDC ID-token (JWKS) validation in the browser login flow.

### Fixed

- **OAuth client auto-registration no longer trusts query-param casts**: `client_id`/`redirect_uri`
  at `/authorize` were read via `as string` casts, but Express yields an *array* for repeated query
  params (`?client_id=a&client_id=b`), which the casts let through unchecked into
  `getClient()`/`registerClient()`. Now narrowed with `typeof === "string"` (the same pattern the
  authorize handler already used for `?provider=`); non-string values fall through to the SDK's own
  validation.
- **Refresh-token exchange now registers the new access token and fires `onTokenExchanged`**:
  `exchangeRefreshToken()` previously returned the refreshed tokens without updating
  `tokenRegistry` or invoking the exchange hook, so verification only worked via the
  single-provider fallback and consumers relying on `onTokenExchanged` (e.g. to rotate a
  downstream credential) never saw the refresh. Now mirrors the authorization-code exchange path.
- **Browser-login upstream fetches now have a timeout**: `exchangeCode()` and
  `validateGitHubToken()` in the stdio browser-login flow omitted `AbortSignal.timeout(...)`,
  unlike every other upstream OAuth call — a hung token/userinfo endpoint could stall the pending
  login flow indefinitely. Now bounded by the same `OAUTH_FETCH_TIMEOUT_MS`.
- **`/ready` no longer reflects raw readiness-check errors to unauthenticated callers**: a
  consumer-provided `readinessCheck()` throwing (e.g. `Error("connect ECONNREFUSED 10.2.3.4:5432")`)
  had its `message` embedded verbatim in the JSON body of the unauthenticated, unrate-limited
  `/ready` endpoint. The client now sees a generic `"<serviceLabel> readiness check failed"`
  reason; the full detail is logged server-side.
- **Graceful HTTP shutdown drains in-flight requests instead of aborting them**: `shutdown()`
  previously called `closeAllConnections()` before `server.close()`, killing any in-flight POST
  immediately. Now `server.close()` + `closeIdleConnections()` run first, giving active requests a
  bounded 3s grace window to finish before a force-close backstop.
- **CORS now exposes the `Mcp-Session-Id` response header**: without `exposedHeaders`, a
  cross-origin browser MCP client could not read the session ID the SDK returns on `initialize`
  and so could never establish a stateful session.
- **Quality/audit pass**: removed a stale `as unknown as MetricReader` cast in the telemetry SDK
  (the OpenTelemetry version skew it worked around is resolved; `PrometheusExporter` now extends
  `MetricReader`); repaired two OAuth provider tests that broke when the callback flow switched from
  an HTTP 302 to an HTML success-redirect page (they now assert the client code carried by the
  `<meta refresh>` page — restoring real coverage of the code-exchange and PKCE-TTL paths); and
  resolved the full ESLint warning backlog (real fixes where genuine — e.g. `(string & {})` on error
  `code` unions to keep known-code autocomplete — and reasoned, documented suppressions where the
  flag was a false positive on trusted-config regexes or intentional boundary/race defense).
- **`AuthOptions.onAuthenticated` now actually called**: The hook was documented since 1.0.x but
  was never invoked — its return value was silently discarded. It is now wired to the auth
  middleware and called after every successful token verification. The result is merged into
  `req.auth.extra` and flows through to `context.auth.extra` in tool handlers as documented.
- **`McpSession.dispose()` no longer silently swallows `sdk.close()` errors**: if the SDK throws
  before its `onerror` callback fires, the error is now logged as a fallback instead of being lost.
- **Final "stopped" log message no longer dropped on shutdown**: `McpServerInstance.stop()` closed
  log streams before logging `SERVER_STOPPED`, so file-based log targets never saw it. The message
  is now logged before `Logger.closeStreams()` runs.
- **`booleanFromEnv()` accepts more truthy spellings**: now uses `parseEnvBoolean()`
  (`1`/`true`/`yes`/`on`, case-insensitive) instead of a bare `=== "true"` comparison.
- **Circular-import crash on startup (`ReferenceError: Cannot access 'CONFIG_FILE_SECTIONS' before
  initialization`)**: `config/extensions.ts` imported `CONFIG_FILE_SECTIONS` via the `config/file`
  barrel instead of directly from the module that defines it, landing in the same import cycle as
  `config/file/loader.ts` and `config/config-cache.ts`. Depending on which module a given entry point
  happened to touch first, ESM's cycle resolution could return that barrel's namespace before its own
  re-export of `CONFIG_FILE_SECTIONS` had run, crashing at module-evaluation time on a `const` still in
  the temporal dead zone. Fixed by importing directly from `config/file/schema.ts` (the actual leaf
  module — matching the pattern `config/file/loader.ts` already used), which is unaffected by the
  cycle regardless of entry order.
- **Server crashed on startup with `Content-Security-Policy received a duplicate directive
  "form-action"` whenever no custom `MCP_HELMET_CSP` was configured**: the default-CSP branch in
  `createExpressApp()` unconditionally added a `formAction` directive on top of Helmet's own
  `getDefaultDirectives()`, which — depending on the installed Helmet version — may already include
  `form-action`; Helmet treats the kebab-case and camelCase spellings as the same directive and
  throws rather than silently merging them. Now only added when not already present in the defaults.

### Changed

- **Typed OAuth token-exchange response**: `parseTokenResponse()` now returns a `TokenResponse`
  type that encodes its existing runtime guarantee (`access_token` is a non-empty string),
  removing two `as string` casts in the token-exchange path (`buildOAuthTokens()` and
  `exchangeAuthorizationCode()`). The OAuth debug log now truncates the upstream authorization
  code via the shared `truncateId()` helper instead of an inline `slice(0, 8)`.
- **Auth-endpoint rate-limit parameters named**: the brute-force limiter's capacity/window
  (CWE-307, see Security) are now `AUTH_RATE_LIMIT_MAX`/`AUTH_RATE_LIMIT_WINDOW_MS` constants
  instead of inline magic numbers.
- **Internal `sanitizeForLog()` renamed to `truncateForLog()`** (transport middleware): the old name
  wrongly implied CWE-117 injection sanitization, but the function only trims and length-bounds
  untrusted input (now via a named `MAX_LOG_INPUT_LENGTH` constant instead of an inline `200`) — the
  actual control-character escaping is applied separately by the Logger pipeline's `InjectionGuard`.
  Renamed for honesty and to disambiguate it from the scrubber's `sanitizeForLogging()`. Internal
  helper (not part of the public package surface); no consumer impact.
- **`mapUserInfo` and `onTokenExchanged` are now ctx-first**: Signature changed from `(token, data) => …`
  to `(ctx: ProviderContext, token, data) => …`. The compiler catches every call site that needs updating.
- **`serverUrl` replaces `serverCallbackUrl`**: The option key in `CreateOAuthProviderOptions` is now
  `serverUrl` (the server base URL; `/callback` is appended internally). The old name is removed.
- **`UpstreamEndpoints` moved to main package**: Previously only accessible as an internal type of
  `upstream-provider.ts`; now a first-class export usable independently of the provider factory.
- **OIDC discovery utilities promoted to first-class exports**: `fetchOidcDiscovery()`,
  `getOidcDiscovery()`, `clearOidcDiscoveryCache()` were previously only reachable as a side-effect of
  `createOidcProvider`. They are now exported from the main package and usable independently.
- **OIDC UserInfo claims validated via Zod**: the default `google`/`oidc` userinfo mapper now runs the
  provider's response through a Zod schema instead of ad-hoc `typeof` casts. A response with a missing
  or wrong-typed `sub`, or a wrong-typed optional claim, now fails with a clear validation error
  instead of silently coercing to `undefined`.
- **`[logging].dir` renamed to `[logging].log_dir`** in the config file (the `LOG_DIR` env var is
  unchanged). Consistent with the key now doubling as the default base directory for the audit trail
  (see `resolveAuditFilePath()` above) — existing config files using `dir` need updating.

### Removed

- **`createUpstreamOAuthProvider`** and its types (`UpstreamOAuthOptions`, `UpstreamOAuthProviderResult`)
  — replaced by `createOAuthProvider({ type: "oauth2", ... })`. Clean break; no compatibility aliases.
- **`createOidcProvider`** and its type (`OidcProviderOptions`) — replaced by
  `createOAuthProvider({ type: "oidc", ... })`. Clean break; no compatibility aliases.
- **`createBearerAuth`** and `BearerAuthOptions` — replaced by
  `createAuthMiddleware({ tokenSource: "bearer", ... })`. Clean break; no compatibility aliases.
- **`createCustomHeaderAuth`** and `CustomHeaderAuthOptions` — replaced by
  `createAuthMiddleware({ tokenSource: { header: "..." }, ... })`. Clean break; no compatibility
  aliases.
- **Test-only reset hooks removed from the public API**: `resetConfigCache`, `resetConfigExtensions`,
  `resetStartupWarnings`, `resetDynamicResourceRegistry`, `resetAllRegistries`. These existed only to
  support test isolation and were never meant for application code.
- **`LogEntryBuilder` / `createLogEntry` removed**: the deprecated fluent log-entry builder
  (superseded by `buildLogEntry()`) had no remaining callers.
- **Narrowed top-level package exports**: several internal/advanced symbols are no longer re-exported
  from the main package entrypoint — `isFullOAuthProvider`, `authInfoExpiry`, `ServerState`,
  `TaskToolRegistry`/`globalTaskToolRegistry`, `parseDuration`/`formatDuration`, and most of the config
  barrel (`getConfigSource`, `CONFIG_FILE_ENV_VAR`, `DISCOVERY_FILENAMES`, `frameworkEnvSchema`,
  `validateConfigConstraints`, `booleanFromEnv`, `commaSeparatedList`, `optionalCommaSeparatedList`,
  `ConfigSource`, `ConfigFileFormat`). Most remain reachable via their internal module paths — this
  only narrows what the top-level package surface promises to keep stable.
- **`DynamicResource*` type exports narrowed**: only `DynamicResourceEntry` remains at the top level;
  `DynamicResourceRegistryOptions`, `RegisterDynamicResourceOptions`, `RegisterDynamicResourceResult`,
  `ReadDynamicResourceResult`, `DefineDynamicResourceTemplateOptions` are no longer re-exported from
  the main package.
- **`tools.log` / `transport.log` file-log slots**: `DEFAULT_LOG_COMPONENTS` no longer includes
  `"tools"`/`"transport"` — nothing in the framework or a consuming server ever logged under those
  exact component names, so the two files were created eagerly on every startup but stayed
  permanently empty. Tool-call visibility already lives in the audit trail (`logAuditEvent`). File
  logging now creates only `server.log` and `api.log` by default.

### Security

- **Open-redirect in local-login guarded**: `POST /authorize/local` accepted any `authorize_url`
  starting with `/` as "same-origin" before re-rendering the selection page — but protocol-relative
  (`//evil.com`) and backslash (`/\evil.com`) forms also start with `/` and resolve to a foreign
  origin in a browser, which was then reflected unescaped into the page's provider-button `href`s
  (an open redirect from an otherwise-trusted login page). Now rejected explicitly, falling back to
  `/authorize`.
- **OIDC discovery endpoints re-validated against the SSRF allowlist**: `fetchOidcDiscovery()`
  validated only the `.well-known` discovery URL itself; the `token_endpoint`/`userinfo_endpoint`/
  `revocation_endpoint`/`jwks_uri` values *inside* the returned document were trusted implicitly,
  even though the framework later POSTs the OAuth `client_secret` and user bearer tokens to them.
  A compromised or MITM'd provider could point these at an internal address (e.g. cloud metadata).
  Every discovered endpoint now passes through the same host-allowlist check as the discovery URL.
- **Empty PKCE challenge rejected in local-login**: a `POST /authorize/local` omitting
  `code_challenge` previously stored an empty string and relied entirely on the SDK's `/token`
  handler to enforce PKCE. Now rejected with 400 at the point the code is minted.
- **Upstream authorization code no longer logged, even truncated**: the debug-level token-exchange
  log previously included the first 8 characters of the upstream `code` — inconsistent with the
  module's otherwise strict no-code-logging discipline. Now logs only the provider name.
- **`req.query` array-injection guard**: Query parameters in the OAuth authorize handler (`provider`,
  `code`, `state`, `error`, `error_description`) are now validated with `typeof value === "string"`
  before use. Express coerces repeated keys to arrays (`?provider=a&provider=b`); the previous casts
  silently coerced `string[]` to `"[object Array]"`.
- **PKCE authorization-code TTL**: `challengeForAuthorizationCode` now throws `InvalidGrantError` when
  the stored PKCE context is older than `codeContextTtlMs`, preventing indefinite replay of stale codes.
- **Provider name removed from 400 responses**: Unknown `?provider=` values are no longer reflected back
  to the client (information disclosure); the value is logged server-side at `warn` level only.
- **Discovery document element-type validation**: `scopes_supported` and
  `token_endpoint_auth_methods_supported` fields from OIDC discovery documents are filtered to `string[]`
  before use, preventing non-string elements from propagating into provider configuration.
- **`form-action 'self'` in the default CSP**: prevents login-CSRF (an attacker page submitting
  credentials cross-origin to `/authorize/local`). A custom `MCP_HELMET_CSP` without `form-action`
  now logs a warning explaining the gap instead of silently omitting it.
- **HSTS defaults on when the framework terminates TLS**: `MCP_HELMET_HSTS` is now tri-state
  (unset / `true` / `false`) instead of a plain boolean defaulting to `false`. When unset, HSTS is
  enabled automatically for `transport.mode: "https"` and left off for plain HTTP or HTTPS
  terminated by a reverse proxy — previously it required an explicit `MCP_HELMET_HSTS=true` even
  when the framework itself served TLS. The warning now fires whenever TLS is terminated here but
  HSTS is off (regardless of `NODE_ENV`), replacing the old production-only check.
- **DNS-rebinding protection now also validates `Origin`**: previously only the `Host` header was
  checked (MCP spec MUST); `Origin` validation is added as the spec-recommended second layer — a
  request whose `Origin` host doesn't match the same allowlist is rejected with 403, same as a bad
  `Host`. Requests without an `Origin` header (non-browser MCP clients) are unaffected.
- **Bounded `redirect_uris` per auto-registered OAuth client**: capped at 20 (CWE-770); further
  updates are rejected with a warning instead of growing the array unboundedly.
- **Dedicated rate limiter on auth endpoints**: `/authorize`, `/token`, `/register`, `/callback`, and
  `/authorize/local` now sit behind their own low-capacity limiter (30 req / 15 min) and DNS-rebinding
  protection, separate from the MCP transport limiter — mitigates auth brute-force (CWE-307).
- **Event stores are now session-scoped — cross-session replay closed**: The SDK's `EventStore`
  contract carries no session context, so with one shared store two gaps existed: (1) the SDK stores
  standalone-GET-stream events under the hardcoded constant `_GET_stream` for *every* session, so all
  sessions' GET-stream events interleaved in one record and a client resuming its own stream could
  replay other sessions' events; (2) a client that learned an event ID from another session's stream
  could replay that stream's messages. The stateful handler now wraps the supplied store in a
  per-session namespacing decorator — replay of any stream outside the session's own scope fails
  closed. On session close, the session's stored events are evicted from the inner store immediately
  (data minimization; the TTL sweep remains the backstop). Applies transparently to **any**
  `EventStore` implementation (in-memory, Redis, ...); no changes needed in consumer code or custom
  stores.

## [1.1.2]

### Changed
- tightened the npm publish workflow, including a production TypeScript build config (`tsconfig.prod.json`) in the publish path
- added a hardened repo-level `.npmrc` with documented defaults for stricter, reproducible installs

## [1.1.1]

### Changed
- updated OTEL dependencies to `0.219.0` to pick up bug fixes and improvements in the OTEL SDKs

## [1.1.0]

### Added

- **`resourceLink()` response helper**: New helper that emits a single `resource_link` content block referencing a server-exposed resource by URI. Use when the link is the entire response — for inline use, prefer the new `links` option below.
- **`links` option on response helpers**: `ResponseOptions` gains an optional `links?: readonly ResourceLinkSpec[]` field. `text()`, `json()`, `structured()`, `error()`, `image()`, `audio()` and `multi()` append one `resource_link` block per entry after the primary content. Lets tools point at large or out-of-band payloads (logs, inspect dumps, compose files) without inlining them — clients call `resources/read` with the URI to retrieve the full content.
- **`ResourceLinkSpec` type**: Exported type for resource link entries (`uri`, `name`, optional `mimeType` / `description` / `title` / `annotations`).
- **`DynamicResourceRegistry`**: In-memory store for ephemeral, session-bound resources. Tools register large per-call payloads at runtime and return only the generated `ephemeral://<category>/<id>` URI to the client. Strict session-binding: `read()` requires the caller's `sessionId` to match the registering session — cross-session reads throw a 403. Per-entry TTL with periodic cleanup, FIFO eviction at `maxEntries`, 32-hex-char ids from `crypto.randomBytes(16)`. Entries owned by a session are released automatically when that session disconnects. Exposed via `getDynamicResourceRegistry()`, `configureDynamicResourceRegistry()` and `resetDynamicResourceRegistry()`.
- **`defineDynamicResourceTemplate()`**: Convenience factory that registers the single resource template (`{scheme}://{category}/{id}`) used to serve all entries from the dynamic registry. Bound to the singleton by default; an explicit `registry` option allows isolated registries (multi-tenant, testing).
- **`ResourceContext` on resource read handlers**: `defineResource()` and `defineResourceTemplate()` pass an optional `ctx?: ResourceContext` argument with `sessionId` and `authInfo`. Existing handlers that ignore the argument keep compiling. This is the mechanism that powers session-bound dynamic resources.
- **`ResourceReadResult` return shape**: `read()` handlers may now return `{ content, mimeType? }` to override the static `mimeType` per call — required when one template serves entries with mixed MIME types.
- **`structured()` response helper**: New helper for tools that declare an `output` schema. Sets `structuredContent` as the primary payload and emits a `TextContent` block alongside it — matching the MCP 2025-06-18 "Structured Content" recommendation that servers SHOULD also return a serialized representation in a `TextContent` block for clients that do not yet read `outputSchema`. By default the helper serializes the payload as pretty-printed JSON; callers may pass `options.text` to provide a custom human-readable rendering (Markdown, ASCII table, etc.) for client UIs while keeping `structuredContent` as the single source of truth for the LLM. Use `text()` for tools without an output schema (state-change confirmations, free-form messages).
- **`StructuredResponseOptions` type**: New options shape exposed alongside the helper. Extends `ResponseOptions` with `text?: string` (custom `TextContent` override) and `indent?: number` (JSON indentation when no `text` is provided, default 2).
- **`output` schema on `defineTool()`**: `ToolDefinition` now accepts an optional `output: ZodTypeAny` field. The framework forwards it to the MCP SDK as `outputSchema`, so it appears in `tools/list` responses and the SDK validates the handler's `structuredContent` against it on every call. Enables typed structured tool results per MCP 2025-06-18 spec without bypassing `defineTool()`.
- **`structuredContent` on response helpers**: `ResponseOptions` exposes an optional `structuredContent` field that `text()`, `json()`, `error()`, `image()`, `audio()` and `multi()` forward onto the resulting `CallToolResult`. Tool handlers can now return both a human-readable `content` array and a typed payload that mirrors the tool's `output` schema in a single call.

### Changed

- **`createSessionManager()` always wraps `onClientDisconnected`**: The session-lifecycle hook is now installed unconditionally so the framework can release dynamic resources tied to a session, regardless of whether the consumer registered a hook. User-supplied hooks still run after the framework cleanup. No behavioral change for consumers that do not use dynamic resources.

## [1.0.6]

### Changed

- **Docs deployment switched to GitHub Actions Pages**: `docs.yml` no longer pushes to a `gh-pages` branch via `peaceiris/actions-gh-pages`. It now uses the official `actions/upload-pages-artifact` + `actions/deploy-pages` flow with two jobs (`build`, `deploy`). Eliminates the Jekyll build error from the GitHub Pages "Deploy from branch" source and removes the deprecated Node.js 20 actions warning.

- **Dependency updates**: Bumped all direct and transitive dependencies to their latest versions.
  - `@opentelemetry/resources`, `@opentelemetry/sdk-metrics`, `@opentelemetry/sdk-trace-base`: `2.6.1` → `2.7.1`
  - `@types/node`: `25.5.0` → `25.6.0`
  - `@typescript-eslint/*`: `8.58.0` → `8.59.2`
  - `dotenv`: `17.3.1` → `17.4.2`
  - `eslint`: `10.1.0` → `10.3.0`
  - `express-rate-limit`: `8.3.2` → `8.5.0`
  - `prettier`: `3.8.1` → `3.8.3`
  - `typedoc`: `0.28.18` → `0.28.19`
  - `typescript-eslint`: `8.58.0` → `8.59.2`
  - `vitest`: `4.1.2` → `4.1.5`
  - `yaml`: `2.8.3` → `2.8.4`

### Security

- **Token permissions hardened across all workflows** (Scorecard #16): Top-level `permissions` in all GitHub Actions workflows are now set to `contents: read` (read-only). Write permissions are scoped to the specific job that requires them. Affected workflows: `docs.yml` (`contents: write` moved to `deploy-docs` job), `publish-npm.yml` (`id-token: write` moved to `publish-npm` job).
- **Eliminated `actions: write` permission in release workflow**: The `publish` job in `release.yml` previously used `gh workflow run` to trigger `publish-npm.yml`, which required `actions: write`. Replaced with a reusable workflow call (`workflow_call`) — `publish-npm.yml` now exposes a `workflow_call` trigger, so `release.yml` invokes it directly without any elevated permissions.

## [1.0.5]

### Fixed

- **Graceful handling of missing `MCP_CONFIG_FILE_PATH`**: If `MCP_CONFIG_FILE_PATH` points to a file that doesn't exist (e.g. Docker volume not mounted, wrong path in env), the server no longer crashes with `ConfigurationError`. Instead a startup warning is buffered and the server continues using environment variables only. An unsupported file extension remains a hard error (typo in env var).

 - Improvements, and security hardening

## [1.0.4] - fix: SSE keepalive, log notification wiring, session logging, security improvements

### Added

- **SSE stream keepalive**: Idle SSE streams (GET `/mcp`, GET `/sse`) are now kept alive with periodic SSE comment lines (`:keepalive`) every 30 seconds. Prevents TCP/proxy idle timeouts from terminating long-lived server-to-client notification streams. Affects both Streamable HTTP (stateful) and legacy SSE transports. Per WHATWG SSE Spec Section 9.2.7.
- **MCP log notification wiring**: Framework logger calls during tool execution are now forwarded as `notifications/message` to the connected MCP client. Uses AsyncLocalStorage context injection so any `logger.*()` call inside a tool handler automatically reaches the client — no manual notification code needed.
- **`sendNotification` on `ToolContext`**: Tool handlers can now send arbitrary MCP server notifications (e.g. `notifications/resources/updated`) via `context.sendNotification()`. Re-exports `ServerNotification` type from the SDK.
- **Per-session `logging/setLevel`**: Each MCP client session independently controls its own log notification verbosity via the `logging/setLevel` request. Previously, `setLevel` was global across all sessions.
- **Progress reporter logging**: `createProgressReporter()` now logs trace/debug messages for rate-limiting, successful sends, and failures — aids debugging without flooding MCP clients.

### Changed

- **`MCP_JSON_RESPONSE` default changed to `false`**: SSE streaming is now the default for all responses. JSON mode silently drops in-flight notifications (progress, logging) because the SDK response stream has no SSE controller — only the final tool result reaches the client. Updated JSDoc with explicit warning.

### Fixed

- **Trace-level MCP notification spam**: `logger.trace()` calls (e.g. progress rate-limiting diagnostics) were being forwarded as MCP `debug` notifications because `trace` mapped to `"debug"` in `LOG_LEVEL_TO_MCP`. Now filtered at both `createContextLogger()` and `forwardToMcpBridge()` entry points — trace stays local.

### Security

- **CWE-770: Rate limiter before auth** (CodeQL #1): Moved rate limiter middleware before authentication middleware in Express pipeline. Previous order allowed unauthenticated clients to bypass rate limiting and brute-force auth endpoints. New order: DNS Rebinding → Rate Limiter → Auth → Protocol Version.
- **CWE-693: Remove `frameguard: false` option** (CodeQL #2): Removed the ability to disable X-Frame-Options entirely via `MCP_HELMET_FRAME_OPTIONS=false`. Disabling clickjacking protection is a security misconfiguration. Only `DENY` and `SAMEORIGIN` are now allowed. For granular framing control, use CSP `frame-ancestors` via `MCP_HELMET_CSP`.
- **CWE-1333: ReDoS in URL trailing-slash removal** (CodeQL #3/#4/#5): Replaced polynomial-time regex `/\/+$/` with linear `stripTrailingSlashes()` utility using `charCodeAt` loop. Fixed in `oidc-discovery.ts` (3 occurrences), `upstream-provider.ts` (1), and `telemetry/sdk.ts` (1).
- **`eslint-plugin-security` integration**: Added Node.js security linting rules (OWASP patterns: eval injection, child_process, unsafe regex, non-literal require, object injection). Custom overrides for framework-specific patterns (File-Writer, ESM-only).
- **Pinned npm version in publish workflow** (Scorecard #7): Changed `npm install -g npm@latest` to `npm@11.12.1` in `publish-npm.yml` for reproducible builds and supply-chain integrity.

## [1.0.3] - BREAKING: Remove connection module, add ReadinessConfig

### Added

- **OTEL Console-Exporter Stdio Guard**: When transport mode is `stdio`, OTEL console exporters (`ConsoleSpanExporter`, `ConsoleMetricExporter`) are automatically overridden to `"none"` with a warning. Console exporters write to stdout, which would corrupt the MCP JSON-RPC protocol. Defense-in-depth measure — users should use `"otlp"` exporter with a collector instead.

### Removed

- **BREAKING**: Removed entire `connection/` module (`ConnectionStateManager`, `ServiceClient`, `ServiceClientFactory`, `HealthCheckResult`, `HealthStatus`, `isServiceClient`)
  - Connection/API management is consumer-specific, not framework responsibility
  - Removed subpath export `mcp-server-framework/connection`
  - Removed `ConnectionError` from error categories and `FrameworkErrorFactory.connection.*`
  - Removed `createConnectionTelemetry()` from telemetry module
  - Removed `ErrorCodes.CONNECTION_ERROR` and `ErrorCategory.CONNECTION`

### Changed

- **BREAKING**: `HealthConfig<TService>` replaced with `ReadinessConfig`
  - Old: `health: { connectionManager, isApiConfigured, apiLabel }`
  - New: `health: { readinessCheck: () => boolean | string, serviceLabel }`
  - `/ready` endpoint no longer reports API connection state
  - `/ready` now calls the generic `readinessCheck()` callback
  - `/ready` handler is now `async` to support async readiness checks

### Fixed

- **Stdio stdout corruption** (critical): Fixed multiple interacting issues that caused `[INFO]` log lines to appear on stdout when using stdio transport, breaking MCP JSON-RPC protocol for clients like Claude Desktop:
  - **Logger default transport**: Changed default `MCP_TRANSPORT` in logger bootstrap from `"http"` to `"stdio"` — the safe default that routes all logs to stderr. Previously, the logger assumed HTTP mode before config was applied, causing early log lines to write to stdout.
  - **Startup log ordering**: Reordered `McpServerInstance.start()` so that `applyProgrammaticOverrides()`, `applyLoggerConfig()`, `setConfigLogger()`, and `flushStartupWarnings()` all execute **before** the first `logger.info(SERVER_STARTING)` call.
  - **Transport mode bridge**: Added `MCP_TRANSPORT` override in `mapServerOptionsToOverrides()` so that programmatic `transport.mode` from `createServer()` / `McpServerBuilder` is correctly propagated to the config system.
  - **Constructor hygiene**: Removed pre-config `logger.debug()` call from `McpServerInstance` constructor that could fire before logger configuration was applied.
- **Logger NODE_ENV type assertion**: Fixed ESLint `no-unnecessary-condition` by reordering the nullish coalescing and type cast — `(process.env.NODE_ENV ?? "development") as ...` instead of casting before `??`

### Migration Guide

Replace `HealthConfig` with `ReadinessConfig`:
```typescript
// Before (v1.x)
import { ConnectionStateManager, type ServiceClient } from 'mcp-server-framework/connection';

health: {
  connectionManager: myManager,
  isApiConfigured: () => !!process.env.API_URL,
  apiLabel: 'my-api',
}

// After (v1.0.3)
health: {
  readinessCheck: () => myManager.isConnected() || 'API not connected',
  serviceLabel: 'my-api',
}
```

Connection management should now be handled locally in consumer code:
```typescript
// Simple local connection tracking (replaces ~565 LOC ConnectionStateManager)
let client: MyApiClient | null = null;
let connected = false;

export function isConnected(): boolean { return connected; }
export function getClient(): MyApiClient | null { return client; }
```

## [1.0.2] - fix: license format, logging improvements, session-not-found response

### Fixed

- **License** updated license files to .txt format for further compatibility and fixed GitHub license auto detection
- **Tool error logging**: Expected tool errors (`statusCode < 500`, e.g. invalid input, not found, auth failures) now logged at WARN with message-only instead of full error object with stack trace. Real errors (`>= 500`) retain full stack trace at ERROR level
- **Session-not-found response**: HTTP 404 responses for expired/unknown sessions now send plain text instead of JSON-RPC body. The MCP SDK reads non-2xx response bodies as raw text, so the previous JSON-RPC envelope appeared as an ugly nested string in client error messages. Affects Streamable HTTP (POST, GET, DELETE) and SSE legacy transport

---

## [1.0.1] - fix: session lifecycle, logging, config & OTEL improvements 

### Added

- `parseDuration()` utility for parsing human-readable durations (`"15m"`, `"1.5h"`, `"500ms"`, `"2d"`, `"1w"`) into milliseconds — analogous to `parseByteSize()`
- `formatDuration()` utility for converting milliseconds to human-readable durations (`"15m"`, `"1h 30m"`, `"2d"`) — inverse of `parseDuration()`
- `durationSchema()` Zod helper for duration environment variables with human-readable defaults — analogous to `byteSizeSchema()`
- `DURATION_REGEX` pattern for validating duration strings in config file schemas
- Export `interpolate()` and `MessageParams` type from the main barrel (`mcp-server-framework`) for consumer use
- `ignoreOutgoingRequestHook` on `HttpInstrumentation` to prevent recursive instrumentation of outgoing OTLP export HTTP calls — eliminates ECONNREFUSED feedback loop when no collector is running

### Changed

- **BREAKING**: Rename `MCP_CONFIG_FILE` environment variable to `MCP_CONFIG_FILE_PATH` for clarity
- **TextFormatter defaults**: `includeTimestamp` and `includeComponent` now default to `false`, matching the framework's env schema defaults (`LOG_TIMESTAMP=false`, `LOG_COMPONENT=false`). Previously the TextFormatter itself defaulted to `true`, causing timestamps and component tags to appear in early startup logs before `applyLoggerConfig()` runs
- **OTEL DiagLogLevel default**: Changed from `INFO` to `WARN` to reduce baseline OTEL SDK diagnostic noise. Users can opt in to verbose output via `OTEL_LOG_LEVEL=DEBUG`
- **Optional transport config**: `CreateServerOptions.transport` and `ServerOptions.transport` are now optional — when omitted, transport mode is resolved from the config cascade (`MCP_TRANSPORT`, `MCP_TLS_CERT_PATH`, `MCP_TLS_KEY_PATH`). Host and port continue to flow through `MCP_BIND_HOST` and `MCP_PORT`
- **OTEL init message**: Now shows active exporter types (`traces`, `metrics`); OTLP endpoint is only displayed when an OTLP exporter is actually configured. Removed duplicate `Starting transport` and redundant `OpenTelemetry initialized` DEBUG log lines. `Server started` promoted from DEBUG to INFO
- Config file field `security.rate_limit_window_ms` renamed to `security.rate_limit_window` — now accepts both numeric milliseconds and human-readable durations (e.g. `"15m"`)
- Config file field `telemetry.metric_export_interval` now accepts both numeric milliseconds and human-readable durations (e.g. `"60s"`)
- `MCP_RATE_LIMIT_WINDOW_MS` env var now accepts human-readable durations (e.g. `"15m"`) in addition to plain millisecond counts
- `OTEL_METRIC_EXPORT_INTERVAL` env var now accepts human-readable durations (e.g. `"60s"`) in addition to plain millisecond counts

### Fixed

- **OTEL metrics default**: `OTEL_METRICS_EXPORTER` default changed to `"prometheus"` only, removing `"otlp"` — reduces instrumentation overhead when no OTLP collector is configured
- **Session limits**: Per-transport limits (`MCP_MAX_STREAMABLE_HTTP_SESSIONS`, `MCP_MAX_SSE_SESSIONS`) are now independent caps within the global `MCP_MAX_SESSIONS` pool (first-come-first-served). Previously the constraint checked `HTTP + SSE <= MAX` (additive), which artificially restricted valid configurations.
- **Session limits**: `MCP_MAX_STREAMABLE_HTTP_SESSIONS` default changed from `100` to `200` to match the global default — no artificial restriction out of the box
- **Session limits**: `hasCapacityForTransport()` now checks the global limit first before per-transport caps, preventing edge cases where the store rejects silently
- **Health endpoint**: `/health` now returns minimal liveness data (`status`, `version`, `uptime`) only — session counts moved to `/ready` where they belong for orchestration probes
- **Session logging**: `InMemorySessionStore` logs (create, close, shutdown) demoted from INFO to TRACE — the store is an internal data layer. `SessionManagerImpl` logs (create, closeAll, dispose) promoted from DEBUG to INFO — the manager is the authoritative public facade. Eliminates confusing duplicate log lines at default log levels. Redundant shutdown logs removed from `removeAll()` — the manager's `closeAll()` already covers the shutdown sequence.
- **Session logging**: Removed redundant TRACE and WARN logs from `McpSession.dispose()` — `sdk.close()` triggers `onclose`/`onerror` callbacks which are the canonical logging source. SSE transport handler `closeOnce` demoted from DEBUG to TRACE to match Streamable HTTP handler pattern.
- **Shutdown log ordering**: `closeAll()` now logs "Closing all sessions..." BEFORE removing sessions from the store, fixing inverted log sequence where store TRACE appeared before manager INFO announcement
- **ESLint**: Removed unnecessary `if (req.query)` guard in `StatefulHandler.resolveSessionId()` — Express `req.query` is always truthy

---

## [1.0.0] - Framework Release

Initial public release. Extracted and generalized from [Komodo MCP Server](https://github.com/MP-Tool/komodo-mcp-server) v1.2.2 into a standalone, client-agnostic framework for building production-ready Model Context Protocol servers.

### Added

#### Server Creation

- `createServer()` high-level API for zero-boilerplate server setup with auto-registry integration
- `McpServerBuilder` fluent builder API for advanced server wiring with full control over providers, lifecycle hooks, and transport configuration
- `ServerInstance` abstraction with `start()`, `stop()`, and state inspection

#### MCP Primitive Factories

- `defineTool()` — type-safe tool definitions with Zod schema validation and auto-registration in the global registry
- `defineResource()` — static URI-based resource definitions with auto-registration
- `defineResourceTemplate()` — dynamic resource templates using RFC 6570 URI templates
- `definePrompt()` — prompt template definitions with typed argument schemas
- `defineApp()` — combined tool + UI resource declarations for rich client interfaces via `_meta.ui.resourceUri`
- `defineTask()` *(experimental)* — async background task definitions with `tasks/list`, `tasks/get`, `tasks/cancel` protocol support

#### Registry System

- `ToolRegistry`, `ResourceRegistry`, `PromptRegistry`, `TaskToolRegistry` classes implementing MCP SDK Provider interfaces directly (no adapter overhead)
- Global registry singletons (`globalToolRegistry`, `globalResourceRegistry`, `globalPromptRegistry`, `globalTaskToolRegistry`) for auto-registration
- `resetAllRegistries()` utility for test isolation
- `BaseRegistry<T>` abstract class with shared registration, lookup, and listing logic
- Scope-based access enforcement via `requireAuth()`, `requireScope()`, `requireScopes()`, `hasScope()`, `hasAllScopes()`, `hasAnyScope()`

#### Response Helpers

- `text()`, `json()`, `error()`, `image()`, `audio()`, `multi()` — ergonomic content constructors replacing manual content array assembly
- Content annotation support (`audience`, `priority`, `lastModified`) on all response helpers

#### Transport Layer

- **Multi-transport architecture** — Stdio, Streamable HTTP (stateful and stateless), SSE (legacy) — same `defineTool()` code works across all modes
- Native HTTPS/TLS support with configurable certificate paths, passphrase, and trust-proxy settings for reverse proxies
- Stateless session mode for serverless and edge deployments with zero state overhead
- SSE stream resumability via pluggable `EventStore` interface
- Express 5.x-based HTTP stack with automatic route mounting for `/sse`, `/message`, and `/mcp` endpoints
- `StdioTransport` wrapper for stdio-mode servers

#### Authentication & Security

- **OAuth 2.1 / OIDC support** with three provider patterns:
  - `createOidcProvider()` — auto-discovery for Keycloak, Auth0, Okta, Azure AD
  - `createUpstreamOAuthProvider()` — upstream OAuth proxy (GitHub, Google, custom)
  - Custom `TokenVerifier` callback for manual token validation
- `fetchOidcDiscovery()` / `getOidcDiscovery()` with in-memory caching and TTL
- `createBearerAuth()` and `createCustomHeaderAuth()` middleware factories
- Security middleware stack enabled by default for HTTP transports:
  - Helmet security headers
  - DNS rebinding protection
  - Configurable rate limiting (`express-rate-limit`)
  - MCP protocol version validation
  - Request logging middleware

#### Session Management

- `SessionManagerImpl` with configurable idle timeouts, heartbeat keep-alive, and dead connection cleanup
- `SessionStore` interface with `InMemorySessionStore` default — pluggable for Redis, PostgreSQL, or any backend
- `SessionHousekeeper` for periodic session cleanup and capacity enforcement
- `SessionFactory` for transport-aware session creation
- Max session capacity with configurable limits

#### Connection Management

- Generic `ConnectionStateManager<TClient>` for API client lifecycle with health checks, state transitions, and reconnection tracking
- `ServiceClient` / `ServiceClientFactory` interfaces — `healthCheck()` is optional
- `isServiceClient()` type guard

#### Configuration

- Five-level config cascade: defaults → `.env` file → config file (TOML / YAML / JSON) → environment variables → programmatic overrides
- Config file auto-discovery (`mcp-server.toml`, `mcp-server.yaml`, `mcp-server.json`) or explicit path via `MCP_CONFIG_FILE`
- `getFrameworkConfig()` for reading resolved configuration at runtime
- `registerConfigSection()` for consumer-defined config extensions
- `getAppConfig()` for reading custom application configuration sections
- `ConfigCache` with startup validation and constraint checking
- Startup warning system for misconfiguration detection
- Env helpers: `booleanFromEnv()`, `commaSeparatedList()`, `optionalCommaSeparatedList()`, `parseEnvBoolean()`, `getEnvString()`, `getEnvOptional()`

#### Logging

- Pipeline-based `Logger` with JSON (ECS-compatible) and text formatters
- File and console writers with `CompositeWriter` for simultaneous output
- `AsyncLocalStorage`-based request context propagation
- Secret scrubbing: JWT, Bearer tokens, and API keys automatically redacted from log output
- CWE-117 log injection guard — strips ANSI escape sequences and neutralizes injection attempts
- `McpLogger` for SDK-level logging notifications to connected MCP clients
- `configureLogger()` / `getLoggerConfig()` for runtime log configuration
- Trace context integration for OpenTelemetry correlation

#### Observability

- OpenTelemetry integration with zero-cost lazy loading (no overhead when disabled)
- Distributed tracing: `getTracer()`, `withSpan()`, `withSpanSync()` helpers
- Metrics collection with `MCP_ATTRIBUTES` semantic conventions
- OTLP and Prometheus export support
- `ConnectionTelemetryBridge` for connection state metric reporting
- `DiagLogger` adapter for OpenTelemetry diagnostics
- `initializeTelemetry()` / `shutdownTelemetry()` lifecycle management

#### Error System

- `AppError` base class with structured error hierarchy:
  - `McpProtocolError` — MCP protocol violations
  - `SessionError` — session lifecycle failures
  - `TransportError` — transport-layer issues
  - `ValidationError` — input validation failures with typed `ValidationIssue` details
  - `ConfigurationError` — configuration errors
  - `OperationError` / `OperationCancelledError` — business logic failures
  - `ConnectionError` — API connectivity issues
  - `AuthenticationError` / `AuthorizationError` — auth failures
  - `InternalError` — unexpected system errors
  - `RegistryError` — registry operation failures
- `FrameworkErrorFactory` — single-import factory with unique error IDs, HTTP/JSON-RPC code mappings, recovery hints, and cause chains
- Full error serialization via `SerializedError` for structured logging and API responses

#### Health & Readiness

- `/health` liveness endpoint (Kubernetes-compatible)
- `/ready` readiness endpoint with aggregated checks: API connectivity, session capacity, configuration validation
- `/metrics` endpoint for Prometheus scraping (when OpenTelemetry is enabled)
- Configurable health check handlers for custom scenarios

#### Lifecycle & Shutdown

- `ServerLifecycleHooks` — `onBeforeStart`, `onAfterStart`, `onBeforeStop`, `onAfterStop` hooks
- Graceful shutdown with SIGINT/SIGTERM handling, session draining, and configurable timeouts
- MCP protocol handlers: ping and progress reporting

#### Utilities

- `z` (Zod) re-export for single-import schema definitions
- String helpers, validation utilities, and Zod helper functions
- Sensitive key detection for log scrubbing

#### Developer Tooling

- TypeDoc configuration for API documentation generation
- ESLint + Prettier configuration
- Vitest test setup
- EditorConfig for consistent code style
- Renovate configuration for automated dependency updates
- GitHub Actions workflows: npm publishing, GitHub Releases with attestation, documentation deployment, OpenSSF Scorecard

#### Subpath Imports

- `mcp-server-framework/config` — configuration access
- `mcp-server-framework/connection` — connection state management
- `mcp-server-framework/errors` — error classes and factory
- `mcp-server-framework/http` — Express app and HTTP server utilities
- `mcp-server-framework/logger` — logging infrastructure
- `mcp-server-framework/session` — session management
- `mcp-server-framework/telemetry` — OpenTelemetry integration

### Infrastructure

- Licensed under LGPL-3.0 (GNU Lesser General Public License v3.0 or later)
- Node.js ≥ 20.0.0 required
- TypeScript 5.x with ESM-only output
- Express 5.x for HTTP transport
- MCP SDK ≥ 1.27.1
