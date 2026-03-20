/**
 * Sensitive Key Detection
 *
 * Shared utility for detecting sensitive field names across the framework.
 * Used by both the error serializer and the logger scrubber to ensure
 * consistent redaction behavior.
 *
 * Uses a segment-based algorithm with a blocklist to minimize false positives:
 * - "password" → sensitive
 * - "keyboard" → NOT sensitive (blocklisted)
 * - "monkey_password" → sensitive ("password" segment is genuinely sensitive)
 *
 * @module utils/sensitive-keys
 */

// ============================================================================
// Sensitive Key Lists
// ============================================================================

/**
 * Keys that are considered sensitive and should be redacted.
 * Includes common authentication and security-related terms.
 */
export const SENSITIVE_KEYS = [
  "password",
  "passwd",
  "apiKey",
  "api_key",
  "apiSecret",
  "api_secret",
  "token",
  "secret",
  "authorization",
  "auth_token",
  "access_token",
  "refresh_token",
  "id_token",
  "jwt",
  "bearer",
  "private_key",
  "privateKey",
  "secret_key",
  "secretKey",
  "passphrase",
  "key",
  "credential",
  "sessionSecret",
  "session_secret",
  "sessionToken",
  "session_token",
  "oauth_token",
  "oauth_secret",
  "oauth_code",
  "client_secret",
  "clientSecret",
] as const;

/**
 * Words that should NOT trigger sensitive key detection even if they
 * contain sensitive key patterns. Prevents false positives.
 */
export const SENSITIVE_KEY_BLOCKLIST = [
  "tokenizer",
  "tokenize",
  "tokenization",
  "keyboard",
  "keyframe",
  "keynote",
  "monkey",
  "passthrough",
  "passenger",
  "passage",
] as const;

// ============================================================================
// Separator & Blocklist Pattern Cache
// ============================================================================

/** Separator pattern for splitting compound keys into segments */
const SEGMENT_SEPARATORS = /[_\-.\s]+/;

/** Pre-compiled blocklist patterns for word-boundary matching */
const BLOCKLIST_PATTERNS = SENSITIVE_KEY_BLOCKLIST.map(
  (word) => new RegExp(`(?:^|[_\\-.\\s])${escapeRegex(word.toLowerCase())}(?:$|[_\\-.\\s])`, "i"),
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Check if a field/key name is sensitive and should be redacted.
 *
 * Algorithm (4 steps):
 * 1. Check if the key contains any sensitive pattern (substring match)
 * 2. If the entire key is an exact blocklist word → not sensitive
 * 3. For compound keys (segments): only sensitive if at least one segment
 *    is genuinely sensitive (not fully explained by blocklist)
 * 4. Single-segment keys: check blocklist patterns
 *
 * @param key - The field name to check
 * @returns true if the key should be redacted
 *
 * @example
 * ```typescript
 * isSensitiveKey('password')         // true
 * isSensitiveKey('api_key')          // true
 * isSensitiveKey('keyboard')         // false (blocklisted)
 * isSensitiveKey('monkey')           // false (blocklisted)
 * isSensitiveKey('monkey_password')  // true  ("password" is genuine)
 * ```
 */
export function isSensitiveKey(key: string): boolean {
  const lowerKey = key.toLowerCase();

  // Step 1: Check if the key matches any sensitive pattern
  const hasSensitiveMatch = SENSITIVE_KEYS.some((sensitiveKey) => lowerKey.includes(sensitiveKey.toLowerCase()));

  if (!hasSensitiveMatch) return false;

  // Step 2: Exact blocklist match exemption
  for (const blocked of SENSITIVE_KEY_BLOCKLIST) {
    if (lowerKey === blocked.toLowerCase()) return false;
  }

  // Step 3: Compound key analysis
  const segments = lowerKey.split(SEGMENT_SEPARATORS).filter(Boolean);
  if (segments.length > 1) {
    return segments.some((segment) => {
      const isSensitive = SENSITIVE_KEYS.some((sk) => segment.includes(sk.toLowerCase()));
      if (!isSensitive) return false;

      const isBlocked = SENSITIVE_KEY_BLOCKLIST.some((blocked) => segment === blocked.toLowerCase());
      return isSensitive && !isBlocked;
    });
  }

  // Step 4: Single segment — check blocklist patterns
  return !BLOCKLIST_PATTERNS.some((pattern) => pattern.test(lowerKey));
}
