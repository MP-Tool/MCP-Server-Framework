# MCP Server Framework

[![License: LGPL-3.0](https://img.shields.io/badge/License-LGPL--3.0-blue.svg)](LICENSE.txt)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9+-blue.svg)](https://www.typescriptlang.org/)
[![MCP SDK](https://img.shields.io/badge/MCP_SDK-1.27+-purple.svg)](https://modelcontextprotocol.io/)
[![Express](https://img.shields.io/badge/Express-5.x-lightgrey.svg)](https://expressjs.com/)

A production-ready TypeScript framework for building [Model Context Protocol](https://modelcontextprotocol.io/) servers — born out of the belief that MCP server development shouldn't mean reinventing infrastructure every time.

## Why This Framework?

When I started building an MCP server for [Komodo MCP Server](https://github.com/MP-Tool/komodo-mcp-server), I quickly realized that the MCP SDK gives you protocol handling, but everything around it — transport management, session lifecycle, security middleware, configuration, observability, error handling — you're on your own. Every MCP server project ends up solving the same problems from scratch if you want a flexible,production-ready MCP server.

This framework extracts that infrastructure into a reusable foundation. The goal is simple: **you focus on your API, tools, resources and prompts — the framework handles everything else.**

It's opinionated where it matters (security defaults, structured logging, transport abstraction) and flexible where it should be (pluggable session stores, optional OpenTelemetry, multiple transport modes). Whether you're building a local CLI tool for Claude Desktop or a multi-client HTTP service in Docker — the same `defineTool()` call works everywhere.

## Disclaimer

This framework is a personal project built with best effort and care. AI tools (GitHub Copilot, Claude) were used extensively during development — for code generation, architecture exploration, and documentation. All AI-generated code and documentation has been critically reviewed, tested, and refined by me.

That said: this software is provided **as-is, without warranty of any kind**. See the [license](LICENSE.txt) for the full legal terms. If you find bugs or have ideas, [issues](https://github.com/MP-Tool/mcp-server-framework/issues) and contributions are always welcome.

## License

[LGPL-3.0](LICENSE.txt) — GNU Lesser General Public License v3.0 or later

## Features

### 🔌 Transport & Protocol

- **Multi-Transport** — Stdio, Streamable HTTP (stateful & stateless), SSE (legacy). Same `defineTool()` code works everywhere.
- **HTTPS / TLS** — Native TLS support with configurable cert/key paths, passphrase, and trust proxy for reverse proxies.
- **Stateless Mode** — Per-request sessions for serverless and edge deployments, zero state overhead.
- **SSE Resumability** — Pluggable `EventStore` interface for resilient SSE stream reconnections.

### 🔐 Authentication & Security

- **OAuth 2.1 / OIDC** — Opt-in auth with three patterns: OIDC auto-discovery (Keycloak, Auth0, Okta, Azure AD), upstream OAuth proxy (GitHub, Google), and custom token verification.
- **Scope-Based Access Control** — Permission guards (`requireAuth`, `requireScope`, `hasScope`) for fine-grained tool access.
- **Security Middleware Stack** — Helmet headers, DNS rebinding protection, configurable rate limiting, protocol version validation — all enabled by default for HTTP transports.
- **Secret Scrubbing** — JWT, Bearer tokens, and API keys automatically redacted from logs. CWE-117 log injection guard strips ANSI escapes and neutralizes injection attempts.

### 🛠️ Developer Experience

- **Type-Safe Factories** — `defineTool()`, `defineResource()`, `defineResourceTemplate()`, `definePrompt()` with full Zod schema validation and auto-completion.
- **MCP Apps** — `defineApp()` combines a tool with a UI resource in one declaration, enabling rich client interfaces via `_meta.ui.resourceUri`.
- **MCP Tasks** *(experimental)* — `defineTask()` for async background work with `tasks/list`, `tasks/get`, `tasks/cancel` protocol support.
- **Zero-Boilerplate** — Auto-registration via global registries. Import a tool file = it's registered. `createServer()` picks it up automatically.
- **Response Helpers** — `text()`, `json()`, `error()`, `image()`, `audio()`, `multi()` — no manual content array assembly.
- **Builder Pattern** — `McpServerBuilder` fluent API for full control: custom providers, lifecycle hooks, explicit wiring.

### 📊 Observability & Operations

- **OpenTelemetry** — Distributed tracing and metrics with zero-cost lazy loading (no overhead when disabled). OTLP and Prometheus export.
- **Structured Logging** — Pipeline-based logger with JSON (ECS) and text formatters, file + console writers, `AsyncLocalStorage` for automatic request context.
- **Dual Logging** — Framework logs go to stderr/files; MCP client notifications go to the connected client via SDK — simultaneously.
- **Health Endpoints** — Kubernetes-ready `/health` (liveness) and `/ready` (readiness with API connectivity, session capacity, and configuration checks).

### ⚙️ Configuration & Session Management

- **12-Factor Config** — Five-level cascade: defaults → `.env` → config file (TOML/YAML/JSON) → environment variables → programmatic overrides.
- **Pluggable Session Store** — `SessionStore` interface with in-memory default. Bring your own Redis, PostgreSQL, or any backend.
- **Session Lifecycle** — Configurable idle timeouts, heartbeat keep-alive, dead connection cleanup, and max session capacity.
- **Connection State Manager** — Generic `ConnectionStateManager<TApi>` with health checks, state transitions, and reconnection tracking for API clients.
- **Graceful Shutdown** — SIGINT/SIGTERM handling, session drain, configurable shutdown timeouts.

### 🧩 Error System

- **Typed Error Hierarchy** — `AppError` base with categories: MCP, Session, Transport, Validation, Configuration, Operation, System.
- **`FrameworkErrorFactory`** — Single import for all error types with unique IDs, HTTP/JSON-RPC code mappings, recovery hints, and cause chains.

## Quick Start

```typescript
import { createServer, defineTool, text, z } from 'mcp-server-framework';

defineTool({
  name: 'greet',
  description: 'Greet someone',
  input: z.object({ name: z.string() }),
  handler: async ({ input }) => text(`Hello, ${input.name}!`),
});

const { start } = createServer({
  name: 'my-server',
  version: '1.0.0',
});

await start();
```

That's it. The tool is auto-registered, the server starts on stdio by default.

## Installation

```bash
npm install mcp-server-framework @modelcontextprotocol/sdk zod
```

**For HTTP transport** (Express is a peer dependency, optional for stdio-only):

```bash
npm install express
```

**For OpenTelemetry** (all optional):

```bash
npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/sdk-metrics \
  @opentelemetry/instrumentation-http @opentelemetry/instrumentation-express \
  @opentelemetry/exporter-trace-otlp-http @opentelemetry/exporter-prometheus
```

**Requirements**: Node.js ≥20.0.0, TypeScript ≥5.0

## Primary API

### High-Level: `createServer()` + `define*()`

```typescript
import { createServer, defineTool, defineResource, definePrompt, text, json, z } from 'mcp-server-framework';

// Tools — auto-registered in the global registry
defineTool({
  name: 'health',
  description: 'Check server health',
  input: z.object({}),
  handler: async () => text('OK'),
});

// Resources — static URI-based content
defineResource({
  uri: 'config://version',
  name: 'Version Info',
  handler: async () => json({ version: '1.0.0' }),
});

// Prompts — reusable prompt templates
definePrompt({
  name: 'summarize',
  description: 'Summarize a topic',
  args: [{ name: 'topic', description: 'Topic to summarize', required: true }],
  handler: async ({ args }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: `Summarize: ${args.topic}` } }],
  }),
});

// Start the server
const { start } = createServer({
  name: 'my-server',
  version: '1.0.0',
});
await start();
```

### Advanced: `McpServerBuilder`

For full control over server composition:

```typescript
import { McpServerBuilder } from 'mcp-server-framework';

const server = new McpServerBuilder()
  .withOptions({
    name: 'advanced-server',
    version: '1.0.0',
    transport: { mode: 'http', host: '0.0.0.0', port: 8000 },
  })
  .withToolProvider(myToolRegistry)
  .withResourceProvider(myResourceProvider)
  .withLifecycleHooks({
    onStarted: () => console.log('Server ready'),
  })
  .build();

await server.start();
```

## Definition Helpers

| Function | Description | Auto-Registration |
|----------|-------------|-------------------|
| `defineTool()` | MCP Tool with Zod schema and handler | `globalToolRegistry` |
| `defineResource()` | Static MCP Resource (URI-based) | `globalResourceRegistry` |
| `defineResourceTemplate()` | URI-template Resource with parameters | `globalResourceRegistry` |
| `definePrompt()` | MCP Prompt with optional arguments | `globalPromptRegistry` |
| `defineApp()` | MCP App (Tool + Resource composition) | `globalToolRegistry` + `globalResourceRegistry` |
| `defineTask()` | Async background task tool (experimental) | `globalTaskToolRegistry` |

## Response Helpers

| Function | Description |
|----------|-------------|
| `text()` | Text content response |
| `json()` | JSON-serialized response |
| `error()` | Error response with `isError: true` |
| `image()` | Base64-encoded image |
| `audio()` | Base64-encoded audio |
| `multi()` | Multi-content response |

## Transport Modes

| Transport | Protocol | Session Mode | Use Case |
|-----------|----------|--------------|----------|
| **Stdio** | — | Single session | CLI, local development (Claude Desktop, VS Code) |
| **Streamable HTTP** (stateful) | 2025-03-26 | Persistent sessions | Production, Docker, multi-client |
| **Streamable HTTP** (stateless) | 2025-03-26 | Per-request | Serverless, edge, horizontal scaling |
| **SSE** (legacy) | 2024-11-05 | Persistent sessions | Backwards compatibility |

```typescript
// Stdio (default)
createServer({ transport: { mode: 'stdio' } });

// HTTP
createServer({ transport: { mode: 'http', host: '0.0.0.0', port: 8000 } });

// HTTPS
createServer({ transport: { mode: 'https', host: '0.0.0.0', port: 8443 } });

// Stateless (serverless / edge)
createServer({ transport: { mode: 'http', host: '0.0.0.0', port: 8000, stateless: true } });
```

## Configuration

The framework follows the [12-Factor App](https://12factor.net/config) methodology.
Sources are merged in order of precedence:

```
Defaults → .env file → Config file → Environment variables → Programmatic overrides
```

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_TRANSPORT` | `http` | Transport mode: `stdio`, `http`, `https` |
| `MCP_BIND_HOST` | `127.0.0.1` | Host to bind to |
| `MCP_PORT` | `8000` | Port to listen on |
| `MCP_STATELESS` | `false` | Stateless mode (no sessions) |
| `MCP_JSON_RESPONSE` | `true` | Prefer JSON over SSE for non-streaming responses |
| `MCP_BODY_SIZE_LIMIT` | `1mb` | Max request body size |
| `LOG_LEVEL` | `info` | Log level: `trace`, `debug`, `info`, `warn`, `error` |
| `OTEL_ENABLED` | `false` | Enable OpenTelemetry tracing & metrics |

**Config file** (auto-discovered as `mcp-server.toml`, `.yaml`, `.json` in CWD):

```toml
[transport]
mode = "http"
host = "0.0.0.0"
port = 8000

[security]
trust_proxy = "loopback"

[session]
timeout_ms = 1800000

[logging]
level = "info"
format = "json"
```

## Subpath Exports

For advanced use cases, internal modules are available via subpath imports:

| Import Path | Purpose |
|-------------|---------|
| `mcp-server-framework` | Main API: `createServer`, `defineTool`, auth providers, guards, helpers |
| `mcp-server-framework/logger` | Logger configuration, child loggers |
| `mcp-server-framework/connection` | `ConnectionStateManager` for API clients |
| `mcp-server-framework/session` | Session internals, `SessionStore` interface |
| `mcp-server-framework/telemetry` | OpenTelemetry tracing & metrics |
| `mcp-server-framework/errors` | Error classes & `FrameworkErrorFactory` |
| `mcp-server-framework/http` | Express app, HTTP/HTTPS server (lazy-loaded) |
| `mcp-server-framework/config` | Config cache, env schema, Zod helpers |

```typescript
import { ConnectionStateManager } from 'mcp-server-framework/connection';
import { FrameworkErrorFactory } from 'mcp-server-framework/errors';
import { withSpan } from 'mcp-server-framework/telemetry';
import type { SessionStore } from 'mcp-server-framework/session';
```

## Architecture

```
src/
├── mcp/           # MCP Protocol Layer
│   ├── capabilities/  # Registries, define*() factories, apps, tasks
│   ├── handlers/      # Ping, progress
│   ├── responses/     # text(), json(), error(), image(), audio(), multi()
│   └── types/         # ToolDefinition, ResourceDefinition, ToolContext
├── server/        # Server Infrastructure
│   ├── auth/          # OAuth 2.1, OIDC auto-discovery, guards
│   ├── builder/       # McpServerBuilder (fluent API)
│   ├── http/          # Express app factory, HTTP/HTTPS server (lazy-loaded)
│   ├── middleware/     # Helmet, DNS rebinding, rate limiting, auth
│   ├── routes/        # Health, readiness, metrics, streamable HTTP, SSE
│   ├── session/       # SessionManager, SessionStore, Housekeeper, auth context
│   ├── transport/     # Stdio, Streamable HTTP, SSE transports
│   └── telemetry/     # OpenTelemetry traces, metrics, SDK init (lazy-loaded)
├── api/           # API Client Abstraction
│   └── connection/    # ConnectionStateManager<TApi>
├── logger/        # Structured Logging
│   ├── scrubbing/     # Secret scrubbing, injection guard
│   ├── formatters/    # JSON (ECS), text
│   └── writers/       # Console, file, composite
├── errors/        # Error System
│   ├── core/          # AppError, ErrorCodes, HTTP/JSON-RPC mappings
│   └── categories/    # Validation, Connection, MCP, Operation, System
├── config/        # Configuration
│   └──                # Env schema (Zod), config cache, file parser
└── utils/         # Helpers
```

## Security

The HTTP middleware stack runs before the MCP SDK processes any request:

```
Request → Trust Proxy → Helmet → DNS Rebinding → Rate Limiter → Auth → Protocol Version → SDK
```

- **Helmet**: Security headers (CSP, X-Frame-Options, HSTS, Referrer-Policy, etc.)
- **DNS Rebinding Protection**: Host header validation against allowed hosts
- **Rate Limiting**: Configurable window, max requests, and custom key generators
- **Trust Proxy**: Native Express trust-proxy support for reverse proxies (nginx, Traefik, Cloud LBs)
- **Secret Scrubbing**: JWT, Bearer tokens, API keys automatically redacted from all log output
- **Log Injection Guard**: CWE-117 protection — ANSI escapes stripped, injection attempts neutralized

## Authentication

OAuth 2.1 and OIDC authentication is **opt-in** — servers work without auth by default.

```typescript
import { createServer, createOidcProvider } from 'mcp-server-framework';

// OIDC auto-discovery (Keycloak, Auth0, Okta, Azure AD, ...)
const { provider, callbackHandler } = await createOidcProvider({
  issuer: 'https://auth.example.com',
  clientId: process.env.OIDC_CLIENT_ID!,
  clientSecret: process.env.OIDC_CLIENT_SECRET!,
  serverUrl: 'http://localhost:8000',
});

const { start } = createServer({
  name: 'secure-server',
  version: '1.0.0',
  transport: { mode: 'http' },
  auth: { provider, callbackHandler },
});
await start();
```

**Supported patterns**:
- **OIDC Auto-Discovery** — `createOidcProvider()` fetches `.well-known/openid-configuration` automatically
- **Upstream OAuth Proxy** — `createUpstreamOAuthProvider()` for GitHub, Google, and other OAuth services
- **Custom Token Verifier** — Implement `TokenVerifier` for API keys, custom JWTs, or any auth scheme
- **Permission Guards** — `requireAuth()`, `requireScope()`, `hasScope()` for tool-level access control

Health (`/health`) and metrics (`/metrics`) endpoints remain unauthenticated for liveness/readiness probes.

## Error Handling

All framework errors extend `AppError` with structured metadata:

```typescript
import { FrameworkErrorFactory } from 'mcp-server-framework/errors';

throw FrameworkErrorFactory.mcp.invalidRequest('Missing required parameter');
throw FrameworkErrorFactory.session.expired('sess-abc123');
throw FrameworkErrorFactory.validation.fieldRequired('name');
```

Each error includes: unique `errorId` (UUID), `code`, `statusCode` (HTTP), `mcpCode` (JSON-RPC),
`recoveryHint`, `cause` chain, and `timestamp`.

## Process Error Handling

The framework handles graceful shutdown (SIGINT, SIGTERM) but delegates process-level error
handling to consumers. Add these handlers in your server entry point:

```typescript
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection: %s', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception: %s', error.message);
  process.exit(1);
});
```

## Tech Stack

### Core

| Technology | Version | Purpose |
|------------|---------|---------|
| TypeScript | ^5.0 | Strict mode, ES2022 target, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` |
| Node.js | ≥20.0.0 | Runtime (ESM, `node:` built-ins) |
| `@modelcontextprotocol/sdk` | ^1.27.1 | MCP Protocol SDK — tools, resources, prompts, transports |
| Express | ^5.2.1 | HTTP/HTTPS transport (lazy-loaded, see DD-018) |
| Zod | ^3.25.0 | Runtime schema validation for tool inputs and config |

### Security & Middleware

| Technology | Version | Purpose |
|------------|---------|---------|
| Helmet | ^8.1.0 | Security headers (CSP, X-Frame-Options, HSTS, etc.) |
| `express-rate-limit` | ^8.2.1 | Configurable request rate limiting |
| CORS | ^2.8.5 | Cross-origin resource sharing |

### Observability (opt-in, lazy-loaded)

| Technology | Version | Purpose |
|------------|---------|---------|
| `@opentelemetry/sdk-node` | ^0.213.0 | OTEL SDK orchestration |
| `@opentelemetry/api` | ^1.9.0 | Tracing API, span context |
| `@opentelemetry/sdk-metrics` | ^2.6.0 | Metrics collection & export |
| `@opentelemetry/instrumentation-http` | ^0.213.0 | Automatic HTTP span instrumentation |
| `@opentelemetry/instrumentation-express` | ^0.61.0 | Automatic Express route instrumentation |
| `@opentelemetry/exporter-prometheus` | ^0.213.0 | Prometheus `/metrics` endpoint |
| `@opentelemetry/exporter-trace-otlp-http` | ^0.213.0 | OTLP trace export (Jaeger, Grafana, etc.) |

### Configuration & Utilities

| Technology | Version | Purpose |
|------------|---------|---------|
| dotenv | ^17.3.1 | `.env` file loading |
| smol-toml | ^1.3.1 | TOML config file parsing |
| yaml | ^2.7.1 | YAML config file parsing |

> **Note**: Express, Zod, and all OpenTelemetry packages are **peer dependencies**. OTEL packages are optional — install only what you need. Express is optional, stdio-only servers.
