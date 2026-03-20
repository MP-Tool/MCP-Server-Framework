/**
 * Readiness Status Constants
 *
 * Extracted from health.ts to avoid loading Express when only the
 * ReadinessStatus constant is needed. This module has zero dependencies
 * and can be safely imported from any barrel without triggering
 * Express module evaluation.
 *
 * @module server/routes/readiness-status
 */

// ============================================================================
// Readiness Status
// ============================================================================

/**
 * Readiness status codes returned by the /ready endpoint.
 *
 * Used by container orchestration (Kubernetes, Docker Swarm, Docker Compose)
 * for readiness probes.
 *
 * @see {@link createHealthRouter} for the route implementation
 */
export const ReadinessStatus = {
  READY: 200,
  SERVICE_UNAVAILABLE: 503,
  TOO_MANY_REQUESTS: 429,
} as const;

export type ReadinessStatusValue = (typeof ReadinessStatus)[keyof typeof ReadinessStatus];
