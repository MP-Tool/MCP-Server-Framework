# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
