/**
 * Secret Scrubber Module
 *
 * Provides utilities for detecting and redacting sensitive information from logs.
 * Handles JWTs, Bearer tokens, and key-value pairs with sensitive keys.
 *
 * @module logger/scrubbing/secret-scrubber
 */

import {
  SENSITIVE_KEYS as BASE_SENSITIVE_KEYS,
  isSensitiveKey as baseSensitiveKeyCheck,
} from "../../utils/sensitive-keys.js";
import { REDACTED_VALUE, JWT_PREFIX } from "../core/constants.js";

/**
 * Pre-compiled regex patterns for secret scrubbing.
 * Performance optimization: compile once at module load instead of on every log call.
 */

/** Regex to match JWTs (eyJ...) - three base64 segments separated by dots */
const JWT_REGEX = new RegExp(`\\b${JWT_PREFIX}[a-zA-Z0-9-_]+\\.[a-zA-Z0-9-_]+\\.[a-zA-Z0-9-_]+`, "g");

/** Regex to match Bearer tokens */
const BEARER_REGEX = /\bBearer\s+[a-zA-Z0-9._~+\-/=]+/gi;

/** Regex to match Basic Auth credentials (Authorization: Basic <base64>) */
const BASIC_AUTH_REGEX = /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi;

/** Regex to match key-value pairs with sensitive keys (excluding bearer/authorization) */
const KV_KEYS = BASE_SENSITIVE_KEYS.filter((k) => !["bearer", "authorization"].includes(k.toLowerCase()));
const KV_PATTERN = KV_KEYS.join("|");
// Pre-computed lowercase keys for fast includes() pre-check before applying regex
const KV_KEYS_LOWER = KV_KEYS.map((k) => k.toLowerCase());
// Use custom boundary instead of \b — word boundaries treat _ as a word character,
// so \bapi_key\b fails to match in "my_api_key=secret". Adding _ - . to the boundary
// class ensures compound keys like my_api_key, app.secret, my-token are matched.
const KV_REGEX = new RegExp(`(^|[\\s"'{(,;_\\-.])(${KV_PATTERN})(\\s*[:=]\\s*)(["']?)([^\\s"']+)\\4`, "gi");

/** Regex to match sensitive URL query parameters (?key=value or &key=value) */
const URL_PARAM_PATTERN = BASE_SENSITIVE_KEYS.filter(
  (k) => !["bearer", "authorization", "key"].includes(k.toLowerCase()),
).join("|");
const URL_PARAM_REGEX = new RegExp(`([?&](?:${URL_PARAM_PATTERN})=)([^&\\s]+)`, "gi");

/** Regex to match credentials in connection strings (scheme://user:pass@host, including IPv6 [::1]) */
const CONN_STRING_REGEX = /:\/\/([^/:@\s[\]]+|\[[^\]]+\]):([^@\s]+)@/g;

/** Regex to match AWS access key IDs (AKIA followed by 16 uppercase alphanumeric characters) */
const AWS_KEY_REGEX = /AKIA[0-9A-Z]{16}/g;

/**
 * Secret Scrubber class for detecting and redacting sensitive information.
 *
 * Usage:
 * - Create a scrubber: `const scrubber = new SecretScrubber();`
 * - Scrub a string: `scrubber.scrub('token=secret123')` returns `'token=**********'`
 * - Scrub an object: `scrubber.scrubObject({ password: 'secret' })` returns `{ password: '**********' }`
 */
export class SecretScrubber {
  /**
   * Additional sensitive keys provided at construction time.
   * These bypass the shared blocklist since they are explicitly
   * provided by the consumer as known-sensitive patterns.
   */
  private readonly additionalKeys: readonly string[];

  /**
   * Create a new SecretScrubber.
   * @param additionalKeys - Additional keys to consider sensitive
   */
  constructor(additionalKeys: string[] = []) {
    this.additionalKeys = additionalKeys;
  }

  /**
   * Scrub secrets from a text string.
   *
   * Handles:
   * - JWTs (eyJ...)
   * - Bearer tokens
   * - Key-value pairs with sensitive keys
   *
   * @param text - The text to scrub
   * @returns The scrubbed text
   */
  public scrub(text: string): string {
    let scrubbed = text;

    // 1. Known Secret Formats (High Confidence) - JWT
    scrubbed = scrubbed.replace(JWT_REGEX, REDACTED_VALUE);

    // 2. Common Auth Headers - Bearer token
    // Run before generic KV scrubber to ensure "Bearer <token>" is handled as a unit
    scrubbed = scrubbed.replace(BEARER_REGEX, `Bearer ${REDACTED_VALUE}`);

    // 3. Basic Auth - "Basic <base64>"
    scrubbed = scrubbed.replace(BASIC_AUTH_REGEX, `Basic ${REDACTED_VALUE}`);

    // 4. AWS access key IDs - "AKIA..."
    scrubbed = scrubbed.replace(AWS_KEY_REGEX, REDACTED_VALUE);

    // 5. Connection strings - "scheme://user:pass@host"
    scrubbed = scrubbed.replace(CONN_STRING_REGEX, `://$1:${REDACTED_VALUE}@`);

    // 6. Sensitive URL query parameters - "?password=xxx&api_key=yyy"
    scrubbed = scrubbed.replace(URL_PARAM_REGEX, `$1${REDACTED_VALUE}`);

    // 7. Context-based Scrubbing (Key-Value pairs)
    // Pre-check: skip expensive regex if no sensitive key substring is present
    const lowerScrubbed = scrubbed.toLowerCase();
    if (KV_KEYS_LOWER.some((k) => lowerScrubbed.includes(k))) {
      scrubbed = scrubbed.replace(KV_REGEX, (match, prefix, key, sep, quote, value) => {
        // Don't redact if already redacted
        if (value.includes(REDACTED_VALUE)) return match;
        return `${prefix}${key}${sep}${quote}${REDACTED_VALUE}${quote}`;
      });
    }

    return scrubbed;
  }

  /**
   * Recursively scrub sensitive keys from an object.
   *
   * Also scrubs string values that may contain embedded secrets
   * (e.g., "password=secret123" patterns).
   *
   * @param obj - The object to scrub
   * @returns A new object with sensitive values redacted
   */
  public scrubObject(obj: unknown): unknown {
    return this.scrubObjectRecursive(obj, new WeakSet());
  }

  /**
   * Internal recursive scrub with circular reference protection.
   */
  private scrubObjectRecursive(obj: unknown, visited: WeakSet<object>): unknown {
    if (typeof obj !== "object" || obj === null) {
      // Scrub string values for embedded secrets (e.g., "token=abc123")
      if (typeof obj === "string") {
        return this.scrub(obj);
      }
      return obj;
    }

    // Circular reference protection — prevent stack overflow
    if (visited.has(obj)) {
      return "[Circular]";
    }
    visited.add(obj);

    if (Array.isArray(obj)) {
      return obj.map((item) => this.scrubObjectRecursive(item, visited));
    }

    const redacted: Record<string, unknown> = {};
    // @type-narrowing — After null-check and Array.isArray, obj is a plain object; TS cannot narrow unknown to Record
    const objRecord = obj as Record<string, unknown>;

    for (const key in objRecord) {
      if (Object.prototype.hasOwnProperty.call(objRecord, key)) {
        if (this.isSensitiveKey(key)) {
          redacted[key] = REDACTED_VALUE;
        } else if (typeof objRecord[key] === "object") {
          redacted[key] = this.scrubObjectRecursive(objRecord[key], visited);
        } else if (typeof objRecord[key] === "string") {
          // @type-narrowing — typeof === 'string' branch; TS does not narrow Record<string, unknown> values via control flow
          redacted[key] = this.scrub(objRecord[key]);
        } else {
          redacted[key] = objRecord[key];
        }
      }
    }

    return redacted;
  }

  /**
   * Check if a key is sensitive.
   *
   * Delegates to the shared utility for base sensitive keys (including
   * blocklist logic). Additional keys provided at construction are checked
   * separately — they bypass the blocklist since they are explicitly
   * declared as sensitive by the consumer.
   *
   * @param key - The key to check
   * @returns true if the key matches a sensitive pattern
   */
  public isSensitiveKey(key: string): boolean {
    // Delegate to shared utility for base sensitive keys (includes blocklist)
    if (baseSensitiveKeyCheck(key)) return true;

    // Check additional keys — explicitly provided, no blocklist needed
    if (this.additionalKeys.length === 0) return false;
    const lowerKey = key.toLowerCase();
    return this.additionalKeys.some((ak) => lowerKey.includes(ak.toLowerCase()));
  }
}

/**
 * Default secret scrubber instance.
 */
export const secretScrubber = new SecretScrubber();
