/**
 * Service Client Types
 *
 * Core service client interface and health check types.
 * The ServiceClient interface defines the minimum contract for connection
 * management with any backend service.
 *
 * @module connection/types
 */

// ============================================================================
// Health Check Types
// ============================================================================

/**
 * Health status values for service client connectivity.
 */
export type HealthStatus = "healthy" | "unhealthy";

/**
 * Health check result from a service client.
 *
 * @example
 * ```typescript
 * const result: HealthCheckResult = {
 *   status: 'healthy',
 *   message: 'Connection established',
 *   details: { responseTime: 42 }
 * };
 * ```
 */
export interface HealthCheckResult {
  /** Health status of the service client */
  readonly status: HealthStatus;

  /** Optional human-readable message */
  readonly message?: string;

  /** Optional additional details for debugging (extensible) */
  readonly details?: {
    readonly [key: string]: unknown;
  };
}

// ============================================================================
// Service Client Interface
// ============================================================================

/**
 * Generic service client interface for connection management.
 *
 * This interface defines the minimum contract that any service client
 * must implement to work with the MCP server framework's connection
 * state management and tool execution.
 *
 * @example
 * ```typescript
 * class MyServiceClient implements ServiceClient {
 *   readonly clientType = 'my-api';
 *
 *   async healthCheck(): Promise<HealthCheckResult> {
 *     try {
 *       await this.ping();
 *       return { status: 'healthy' };
 *     } catch (error) {
 *       return { status: 'unhealthy', message: error.message };
 *     }
 *   }
 * }
 * ```
 */
export interface ServiceClient {
  /**
   * Unique identifier for the client type.
   * Used for logging and telemetry attribution.
   *
   * @example 'my-api', 'docker', 'kubernetes'
   */
  readonly clientType: string;

  /**
   * Performs a health check to verify connectivity.
   *
   * This method is OPTIONAL. If not provided, the framework assumes
   * the client is healthy when connected.
   *
   * When provided, this method is called:
   * - During initial connection to validate credentials
   * - Periodically to monitor connection health
   * - On reconnection attempts
   *
   * Implementations should:
   * - Make a lightweight API call (e.g., ping, version check)
   * - Return quickly (timeout recommended: 5-10 seconds)
   * - NOT throw errors - return unhealthy status instead
   *
   * @returns Health check result with status and optional details
   */
  healthCheck?(): Promise<HealthCheckResult>;

  /**
   * Gracefully release resources held by the client.
   *
   * This method is OPTIONAL. If provided, it is called by
   * {@link ConnectionStateManager} during disconnect to allow
   * the client to close sockets, drain pools, flush buffers, etc.
   *
   * Implementations should:
   * - Release all held resources (connections, file handles, timers)
   * - Be idempotent (safe to call multiple times)
   * - NOT throw errors — log and swallow instead
   *
   * @returns Resolves when cleanup is complete
   */
  disconnect?(): Promise<void>;
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard to check if an object implements ServiceClient.
 *
 * @param obj - Object to check
 * @returns True if obj implements ServiceClient interface
 *
 * @example
 * ```typescript
 * if (isServiceClient(maybeClient)) {
 *   const result = await maybeClient.healthCheck();
 * }
 * ```
 */
export function isServiceClient(obj: unknown): obj is ServiceClient {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "clientType" in obj &&
    // @type-guard — After 'in' check, property exists but TS cannot narrow unknown for property access
    typeof (obj as ServiceClient).clientType === "string" &&
    // healthCheck is optional - only validate if present
    // @type-guard — Same pattern: validate optional property type after 'in' existence check
    (!("healthCheck" in obj) || typeof (obj as ServiceClient).healthCheck === "function") &&
    // disconnect is optional - only validate if present
    // @type-guard — Same pattern: validate optional property type after 'in' existence check
    (!("disconnect" in obj) || typeof (obj as ServiceClient).disconnect === "function")
  );
}

// ============================================================================
// Factory Types
// ============================================================================

/**
 * Factory function type for creating service clients.
 *
 * @public Exported for consumer dependency injection and testing patterns.
 *
 * @typeParam TService - The service client type to create
 * @typeParam TConfig - Configuration type for client creation
 */
export type ServiceClientFactory<TService extends ServiceClient, TConfig = unknown> = (
  config: TConfig,
) => Promise<TService>;
