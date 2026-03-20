/**
 * Handler Types
 *
 * Types for MCP protocol handler configuration.
 * Provides callback types for customizing handler behavior.
 *
 * @module mcp/types/handler
 */

// ============================================================================
// Custom Handler Callbacks
// ============================================================================

/**
 * Custom ping handler callback.
 *
 * Called when a ping request is received from an MCP client.
 * Use for health checks, metrics, heartbeat tracking, or custom logic.
 *
 * The return value is ignored - ping always returns an empty object
 * per MCP specification. If the handler throws, the ping still succeeds
 * (errors are logged but not propagated to the client).
 *
 * @example
 * ```typescript
 * const options: ServerOptions = {
 *   // ...
 *   handlers: {
 *     onPing: async () => {
 *       metrics.increment('mcp.ping.received');
 *       await healthChecker.recordHeartbeat();
 *     },
 *   },
 * };
 * ```
 */
export type PingHandler = () => void | Promise<void>;

// ============================================================================
// Handlers Configuration
// ============================================================================

/**
 * Protocol handler configuration.
 *
 * Allows customizing behavior when MCP protocol events occur.
 * All handlers are optional - the framework provides default behavior.
 *
 * Note: Cancellation is handled automatically by the framework.
 * There is no hook for cancellation as it must always abort requests.
 *
 * @example
 * ```typescript
 * const handlers: HandlersConfig = {
 *   onPing: () => metrics.increment('mcp.ping'),
 * };
 * ```
 */
export interface HandlersConfig {
  /**
   * Called when a ping request is received.
   *
   * Use for health checks, metrics, or heartbeat tracking.
   * Return value is ignored (ping always returns empty object).
   */
  onPing?: PingHandler;
}
