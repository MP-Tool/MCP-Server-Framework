/**
 * Error Categories Barrel Export
 *
 * @module errors/categories
 */

// MCP Protocol Errors (split from former mcp.ts)
export { McpProtocolError } from "./protocol.js";
export { SessionError } from "./session.js";
export { TransportError } from "./transport.js";

// Validation Errors
export { ValidationError, ConfigurationError } from "./validation.js";

// System Errors
export { InternalError, RegistryError } from "./system.js";

// Operation Errors
export { OperationError, OperationCancelledError } from "./operation.js";

// Auth Errors
export { AuthenticationError, AuthorizationError } from "./auth.js";
