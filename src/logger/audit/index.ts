/**
 * Audit subsystem barrel.
 *
 * @module logger/audit
 */

export { auditActor, logAuditEvent, initializeAuditLog, resolveAuditFilePath } from "./audit-log.js";
export type { AuditEvent, AuditActor, AuditCategory, AuditOutcome, AuditLogOptions } from "./audit-log.js";
