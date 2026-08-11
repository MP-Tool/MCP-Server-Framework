/**
 * HTTP Transport
 *
 * Starts an HTTP or HTTPS server from a configured Express application.
 * Returns a lightweight TransportHandle for shutdown and info queries.
 *
 * @module server/http/http-transport
 */

import type { Server } from "node:http";
import type { Application } from "express";

import type { TransportHandle, TransportInfo } from "../transport/types.js";
import type { HttpTransportOptions, HttpsTransportOptions } from "../server-options.js";
import { startHttpServer, startHttpsServer } from "./http-server.js";
import { logger as baseLogger } from "../../logger/index.js";
import { TRANSPORT_LOG_COMPONENTS } from "../transport/constants.js";

const logger = baseLogger.child({
  component: TRANSPORT_LOG_COMPONENTS.HTTP_SERVER,
});

const LogMessages = {
  TRANSPORT_STARTING: "Starting %s transport...",
  SERVER_CLOSED: "HTTP server closed",
  SHUTDOWN_ERROR: "Error during HTTP server shutdown: %s",
} as const;

/**
 * Grace window for in-flight HTTP requests to finish during shutdown before their sockets
 * are force-closed. Bounded so a stuck request can't hang the process; the outer
 * server-instance shutdown timeout is the ultimate backstop.
 */
const SHUTDOWN_DRAIN_MS = 3000;

// ============================================================================
// Options
// ============================================================================

/**
 * Options for starting the HTTP transport.
 *
 * Accepts the narrowed discriminated union member directly.
 */
export interface HttpTransportStartOptions {
  /** The HTTP or HTTPS transport configuration from the discriminated union */
  readonly transport: HttpTransportOptions | HttpsTransportOptions;
}

// ============================================================================
// HTTP Transport Function
// ============================================================================

/**
 * Starts an HTTP or HTTPS transport server.
 *
 * Creates and starts the appropriate server:
 * - HTTP mode: Plain HTTP server (development, behind reverse proxy)
 * - HTTPS mode: HTTPS server with TLS (direct TLS termination)
 *
 * @param app - Configured Express application
 * @param options - Transport configuration
 * @returns TransportHandle for shutdown and runtime info
 */
export async function startHttpTransport(
  app: Application,
  options: HttpTransportStartOptions,
): Promise<TransportHandle> {
  const startedAt = new Date();
  const { transport } = options;
  const useTls = transport.mode === "https";

  logger.debug(LogMessages.TRANSPORT_STARTING, useTls ? "HTTPS" : "HTTP");

  const serverOptions = {
    port: transport.port,
    bindHost: transport.host,
  };

  let server: Server;

  if (useTls) {
    server = await startHttpsServer(app, {
      ...serverOptions,
      tls: transport.tls,
    });
  } else {
    server = await startHttpServer(app, serverOptions);
  }

  return {
    async shutdown(): Promise<void> {
      // Graceful drain (Node ≥18.2):
      //   1. server.close() stops accepting new connections and resolves once all active
      //      requests have finished.
      //   2. closeIdleConnections() immediately drops keep-alive sockets with no in-flight
      //      request — otherwise close() would block waiting for them to time out.
      //   3. A bounded grace timer then force-closes any still-active sockets, so a slow or
      //      stuck in-flight request cannot hang shutdown indefinitely.
      // This gives in-flight POSTs a short window to complete instead of the previous
      // unconditional closeAllConnections() that aborted them immediately. SSE streams are
      // already closed upstream by sessionManager.closeAll() before this runs.
      const closed = new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            logger.error(LogMessages.SHUTDOWN_ERROR, err.message);
            reject(err);
          } else {
            logger.info(LogMessages.SERVER_CLOSED);
            resolve();
          }
        });
      });

      server.closeIdleConnections();
      const forceTimer = setTimeout(() => server.closeAllConnections(), SHUTDOWN_DRAIN_MS);
      forceTimer.unref();

      try {
        await closed;
      } finally {
        clearTimeout(forceTimer);
      }
    },

    info(): TransportInfo {
      return {
        state: "running",
        startedAt,
        mode: transport.mode,
        host: transport.host,
        port: transport.port,
      };
    },
  };
}
