/**
 * HTTP Transport
 *
 * Express application factory and HTTP/HTTPS server creation.
 *
 * @module server/http
 */

export { createExpressApp } from "./express-app.js";
export type { ExpressAppOptions } from "./express-app.js";
export { startHttpServer, startHttpsServer, readTlsCredentials } from "./http-server.js";
export type { HttpServerOptions, HttpsServerOptions } from "./http-server.js";
export { startHttpTransport } from "./http-transport.js";
export type { HttpTransportStartOptions } from "./http-transport.js";
export type { SessionFactory, TransportHandle, TransportInfo, TransportState } from "../transport/types.js";
