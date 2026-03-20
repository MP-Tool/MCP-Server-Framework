/**
 * Connection Module Constants
 *
 * Centralized constants for the connection module including:
 * - Configuration values
 * - Log component identifiers
 * - MCP specification references
 * - Log messages
 *
 * @module connection/core/constants
 */

// ============================================================================
// Configuration Constants
// ============================================================================

/**
 * Connection state configuration constants.
 */
export const CONNECTION_STATE_CONFIG = {
  /**
   * Maximum number of state transitions to keep in history.
   * Uses circular buffer for O(1) operations.
   */
  MAX_HISTORY_SIZE: 10,

  /**
   * Default timeout for health checks in milliseconds.
   */
  HEALTH_CHECK_TIMEOUT_MS: 10_000,
} as const;

/**
 * Default configuration for auto-reconnect.
 * Modeled after the SDK's StreamableHTTPReconnectionOptions pattern.
 */
export const RECONNECT_DEFAULTS = {
  /** Maximum number of reconnect attempts before giving up. */
  MAX_RETRIES: 5,
  /** Initial delay before the first reconnect attempt (ms). */
  INITIAL_DELAY_MS: 1_000,
  /** Maximum delay between reconnect attempts (ms). */
  MAX_DELAY_MS: 30_000,
  /** Exponential backoff multiplier. */
  BACKOFF_MULTIPLIER: 1.5,
} as const;

// ============================================================================
// State Machine Transition Rules
// ============================================================================

/**
 * Valid state transitions for the connection state machine.
 *
 * Enforces the documented state graph:
 * ```
 * disconnected ──▶ connecting ──▶ connected
 *      ▲                │              │
 *      │                ▼              ▼
 *      └──────────── error ◀──────────┘
 * ```
 *
 * Additional transitions allowed for practical use:
 * - `connected → disconnected` (explicit disconnect)
 * - `error → disconnected` (reset)
 */
export const VALID_STATE_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  disconnected: ["connecting"],
  connecting: ["connected", "error", "disconnected"],
  connected: ["connecting", "disconnected", "error"],
  error: ["connecting", "disconnected"],
} as const;

// ============================================================================
// Log Component Identifiers
// ============================================================================

/**
 * Logger component identifiers for the connection module.
 * Used for consistent log categorization.
 */
export const CONNECTION_LOG_COMPONENTS = {
  /** Connection state manager component */
  CONNECTION_STATE: "ConnectionStateManager",
  /** Client initializer component */
  CLIENT_INITIALIZER: "ClientInitializer",
} as const;

// ============================================================================
// MCP Specification References
// ============================================================================

/**
 * MCP specification URLs for documentation and compliance references.
 */
export const CONNECTION_MCP_SPEC = {
  /** MCP specification version */
  VERSION: "2025-11-25",
  /** Base URL for MCP specification */
  BASE_URL: "https://spec.modelcontextprotocol.io/specification/2025-11-25",
  /** Progress notifications specification */
  PROGRESS_URL: "https://spec.modelcontextprotocol.io/specification/2025-11-25/server/utilities/progress/",
  /** Cancellation specification */
  CANCELLATION_URL: "https://spec.modelcontextprotocol.io/specification/2025-11-25/basic/cancellation/",
} as const;

// ============================================================================
// Log Messages
// ============================================================================

/**
 * Centralized log messages for connection state management.
 */
export const ConnectionStateLogMessages = {
  // State transitions
  STATE_CHANGE: "State transition: %s → %s",
  CONNECTING: "Initiating connection to API server",
  CONNECTED: "Successfully connected to API server",
  DISCONNECTED: "Disconnected from API server",
  ERROR_STATE: "Connection error: %s",

  // Health check
  HEALTH_CHECK_START: "Starting health check",
  HEALTH_CHECK_SUCCESS: "Health check passed",
  HEALTH_CHECK_FAILED: "Health check failed: %s",
  HEALTH_CHECK_SKIPPED: "Health check skipped",
  HEALTH_CHECK_TIMEOUT: "Health check timed out after %dms",

  // State machine
  INVALID_TRANSITION: "Invalid state transition: %s → %s (allowed from %s: %s)",

  // Client lifecycle
  CLIENT_DISCONNECT_ERROR: "Client disconnect failed (ignored): %s",

  // Listeners
  LISTENER_ADDED: "State change listener added",
  LISTENER_REMOVED: "State change listener removed",
  LISTENER_ERROR: "Listener threw error: %s",
  LISTENERS_CLEARED: "All listeners cleared",

  // Reset
  RESET: "Connection state manager reset to initial state",

  // Auto-Reconnect
  RECONNECT_ENABLED: "Auto-reconnect enabled (maxRetries=%d, initialDelay=%dms, maxDelay=%dms)",
  RECONNECT_DISABLED: "Auto-reconnect disabled",
  RECONNECT_ATTEMPT: "Reconnect attempt %d/%d in %dms",
  RECONNECT_SUCCESS: "Reconnect succeeded after %d attempt(s)",
  RECONNECT_FAILED: "Reconnect attempt %d/%d failed: %s",
  RECONNECT_EXHAUSTED: "All %d reconnect attempts exhausted — staying in error state",
  RECONNECT_ABORTED: "Reconnect aborted",
} as const;

/**
 * Centralized log messages for client initialization.
 */
export const ClientInitializerLogMessages = {
  // Initialization
  INIT_START: "Initializing API client from environment variables",
  INIT_SUCCESS: "Client initialized successfully using %s",
  INIT_FAILED: "Client initialization failed: %s",

  // Configuration
  CONFIG_MISSING: "Missing required configuration",
  CONFIG_URL_MISSING: "API URL environment variable not set",
  CONFIG_AUTH_MISSING: "No authentication method configured (need API_KEY or USERNAME/PASSWORD)",

  // Authentication
  AUTH_API_KEY: "Using API key authentication",
  AUTH_CREDENTIALS: "Using username/password authentication",
} as const;
