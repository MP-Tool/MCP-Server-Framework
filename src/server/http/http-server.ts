/**
 * HTTP/HTTPS Server Creation
 *
 * Factory functions for creating HTTP and HTTPS servers from
 * a configured Express application.
 *
 * The server creation is separated from app configuration to support
 * three transport modes:
 * - `startHttpServer()` — Plain HTTP (development, behind reverse proxy)
 * - `startHttpsServer()` — HTTPS with TLS (direct TLS termination)
 *
 * TLS credentials are read from the filesystem using paths configured
 * via environment variables or programmatic options.
 *
 * @module server/http/http-server
 */

import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { SecureContextOptions } from "node:tls";
import { readFileSync, statSync } from "node:fs";
import type { Application } from "express";
import type { AddressInfo } from "node:net";

import { logger as baseLogger } from "../../logger/index.js";
import { TRANSPORT_LOG_COMPONENTS } from "../transport/constants.js";
import type { TlsConfig } from "../server-options.js";
import { getFrameworkConfig } from "../../config/index.js";
import { TransportError } from "../../errors/index.js";

/**
 * HTTP Server Configuration Options.
 */
export interface HttpServerOptions {
  /** Port to listen on (default: from MCP_PORT env or 8000) */
  readonly port?: number | undefined;
  /** Host to bind to (default: from MCP_BIND_HOST env or '127.0.0.1') */
  readonly bindHost?: string | undefined;
}

/**
 * HTTPS Server Configuration Options.
 */
export interface HttpsServerOptions extends HttpServerOptions {
  /** TLS certificate configuration */
  readonly tls: TlsConfig;
}

const logger = baseLogger.child({
  component: TRANSPORT_LOG_COMPONENTS.HTTP_SERVER,
});

/** @internal Log messages for HTTP/HTTPS server lifecycle */
const LogMessages = {
  TLS_READING_CREDENTIALS: "Reading TLS credentials: cert=%s, key=%s, ca=%s",
  HTTP_LISTENING: "HTTP server listening on http://%s:%d",
  HTTPS_LISTENING: "HTTPS server listening on https://%s:%d",
  PORT_IN_USE: "Port %s is already in use — server cannot start",
  PORT_REQUIRES_PRIVILEGES: "Binding to %s requires elevated privileges",
  SERVER_ERROR: "Unexpected server error: %s",
} as const;

/** Maximum allowed TLS file size (1 MB) — prevents accidental reads of large files */
const MAX_TLS_FILE_SIZE = 1024 * 1024;

// ── HTTP Timeout Defaults ─────────────────────────────────────────────────
// Industry-standard values to prevent resource exhaustion (Slowloris, idle connections).
// headersTimeout must be > requestTimeout per Node.js docs.

/** Max time for the entire request (30s) */
const HTTP_REQUEST_TIMEOUT = 30_000;
/** Max time for headers to arrive (40s, must exceed requestTimeout) */
const HTTP_HEADERS_TIMEOUT = 40_000;
/** Idle keep-alive timeout (65s, exceeds common LB thresholds like ALB 60s) */
const HTTP_KEEP_ALIVE_TIMEOUT = 65_000;

// ============================================================================
// TLS Credential Reading
// ============================================================================

/**
 * Reads a single TLS file with size validation.
 *
 * @param filePath - Path to the TLS file (cert, key, or CA)
 * @returns File contents as UTF-8 string
 * @throws TransportError if file exceeds MAX_TLS_FILE_SIZE
 */
function readTlsFile(filePath: string): string {
  const { size } = statSync(filePath);
  if (size === 0) {
    throw new TransportError(`TLS file is empty (0 bytes): ${filePath}`);
  }
  if (size > MAX_TLS_FILE_SIZE) {
    throw new TransportError(
      `TLS file exceeds maximum allowed size of ${MAX_TLS_FILE_SIZE} bytes: ${filePath} (${size} bytes)`,
    );
  }
  return readFileSync(filePath, "utf-8");
}

/**
 * Reads TLS credentials from the filesystem.
 *
 * @param tls - TLS configuration with file paths
 * @returns Node.js SecureContextOptions for https.createServer
 * @throws TransportError if files exceed size limit or cannot be read
 */
export function readTlsCredentials(tls: TlsConfig): SecureContextOptions {
  logger.debug(LogMessages.TLS_READING_CREDENTIALS, tls.certPath, tls.keyPath, tls.caPath ?? "none");

  const credentials: SecureContextOptions = {
    cert: readTlsFile(tls.certPath),
    key: readTlsFile(tls.keyPath),
  };

  if (tls.caPath) {
    credentials.ca = readTlsFile(tls.caPath);
  }

  return credentials;
}

// ============================================================================
// Server Defaults
// ============================================================================

/**
 * Resolves server options with framework environment defaults.
 */
function resolveOptions(options: HttpServerOptions = {}): {
  port: number;
  bindHost: string;
} {
  const frameworkConfig = getFrameworkConfig();
  return {
    port: options.port ?? frameworkConfig.MCP_PORT,
    bindHost: options.bindHost ?? frameworkConfig.MCP_BIND_HOST,
  };
}

// ============================================================================
// HTTP Server
// ============================================================================

/**
 * Creates and starts a plain HTTP server.
 *
 * Resolves after the server is listening and ready to accept connections.
 *
 * @param app - Configured Express application
 * @param options - Server configuration (defaults to environment variables)
 * @returns Running HTTP server instance
 */
export function startHttpServer(app: Application, options: HttpServerOptions = {}): Promise<Server> {
  const { port, bindHost } = resolveOptions(options);

  return new Promise<Server>((resolve, reject) => {
    const server = createHttpServer(app);
    server.requestTimeout = HTTP_REQUEST_TIMEOUT;
    server.headersTimeout = HTTP_HEADERS_TIMEOUT;
    server.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT;

    server.on("error", (error: NodeJS.ErrnoException) => {
      reject(handleServerError(error, port, bindHost));
    });

    server.listen(port, bindHost, () => {
      // @node-api — server.address() returns string | AddressInfo | null; inside listen() callback it is always AddressInfo
      const addr = server.address() as AddressInfo;
      logger.info(LogMessages.HTTP_LISTENING, addr.address, addr.port);
      resolve(server);
    });
  });
}

// ============================================================================
// HTTPS Server
// ============================================================================

/**
 * Creates and starts an HTTPS server with TLS.
 *
 * Reads TLS credentials from the filesystem at startup.
 * Resolves after the server is listening and ready to accept connections.
 * Certificate rotation requires server restart.
 *
 * @param app - Configured Express application
 * @param options - Server configuration with TLS options
 * @returns Running HTTPS server instance
 */
export function startHttpsServer(app: Application, options: HttpsServerOptions): Promise<Server> {
  const { port, bindHost } = resolveOptions(options);

  const credentials = readTlsCredentials(options.tls);

  return new Promise<Server>((resolve, reject) => {
    const server = createHttpsServer(credentials, app);
    server.requestTimeout = HTTP_REQUEST_TIMEOUT;
    server.headersTimeout = HTTP_HEADERS_TIMEOUT;
    server.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT;

    server.on("error", (error: NodeJS.ErrnoException) => {
      reject(handleServerError(error, port, bindHost));
    });

    server.listen(port, bindHost, () => {
      // @node-api — server.address() returns string | AddressInfo | null; inside listen() callback it is always AddressInfo
      const addr = server.address() as AddressInfo;
      logger.info(LogMessages.HTTPS_LISTENING, addr.address, addr.port);
      resolve(server);
    });
  });
}

// ============================================================================
// Error Handling
// ============================================================================

/**
 * Handles critical server errors like EADDRINUSE and EACCES.
 *
 * @param error - Node.js error with errno code
 * @param port - Configured port number
 * @param bindHost - Configured bind host
 */
function handleServerError(error: NodeJS.ErrnoException, port: number, bindHost: string): Error {
  if (error.syscall !== "listen") {
    return error;
  }

  const bind = `${bindHost}:${port}`;

  switch (error.code) {
    case "EADDRINUSE":
      logger.error(LogMessages.PORT_IN_USE, bind);
      return TransportError.portInUse(bind);
    case "EACCES":
      logger.error(LogMessages.PORT_REQUIRES_PRIVILEGES, bind);
      return TransportError.privilegesRequired(bind);
    default:
      logger.error(LogMessages.SERVER_ERROR, error.message);
      return error;
  }
}
