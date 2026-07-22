/**
 * Secret Scrubber Module
 *
 * Generic, protocol-agnostic secret-detection/redaction engine. Used by the
 * logger's own output-sanitization pipeline as well as multiple `mcp/capabilities/`
 * consumers (tool-result boundary, resource registries) — a reusable primitive,
 * not a logger-specific concern.
 *
 * @module utils/scrubbing/secret-scrubber
 */

/* eslint-disable security/detect-non-literal-regexp -- redaction patterns are compiled from the
   framework's own SENSITIVE_KEYS blocklist and internal constants, plus consumer-declared
   `additionalKeys` that are individually regex-escaped via escapeRegex() — the resulting
   alternations are always literal, no regex semantics can be injected. */
import {
  SENSITIVE_KEYS as BASE_SENSITIVE_KEYS,
  isSensitiveKey as baseSensitiveKeyCheck,
  escapeRegex,
} from "../sensitive-keys.js";

/** Mask applied to redacted values (distinct from the errors module's bracket-style `[REDACTED]`). */
export const REDACTED_VALUE = "**********";

/** Prefix identifying a JWT's base64url-encoded header segment. */
const JWT_PREFIX = "eyJ";

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

/**
 * Key-driven text patterns, compiled per key set.
 *
 * The KV and URL-param passes embed the sensitive key names directly in their
 * regex alternations, so they must be recompiled per scrubber instance —
 * otherwise consumer-declared `additionalKeys` would apply to object-key
 * matching and the JSON pass, but silently NOT to plain-text `KEY=value`
 * blocks (their primary use case) or URL query parameters.
 */
interface CompiledKeyPatterns {
  /** `key=value` / `key: value` pairs with a sensitive key */
  readonly kvRegex: RegExp;
  /** Sensitive URL query parameters (`?key=value` / `&key=value`) */
  readonly urlParamRegex: RegExp;
  /** Lowercased key fragments for the fast includes() pre-check */
  readonly kvKeysLower: readonly string[];
}

/** Base keys minus the ones handled by dedicated passes (Bearer/Basic auth). */
const KV_BASE_KEYS = BASE_SENSITIVE_KEYS.filter((k) => !["bearer", "authorization"].includes(k.toLowerCase()));
const URL_PARAM_BASE_KEYS = BASE_SENSITIVE_KEYS.filter(
  (k) => !["bearer", "authorization", "key"].includes(k.toLowerCase()),
);

/**
 * Compile the key-driven text patterns for the base keys plus the given
 * consumer `additionalKeys` (each regex-escaped — explicit declarations join
 * both alternations unfiltered).
 */
function compileKeyPatterns(additionalKeys: readonly string[]): CompiledKeyPatterns {
  const extra = additionalKeys.map((k) => escapeRegex(k));
  const kvPattern = [...KV_BASE_KEYS, ...extra].join("|");
  const urlPattern = [...URL_PARAM_BASE_KEYS, ...extra].join("|");
  return {
    // Use custom boundary instead of \b — word boundaries treat _ as a word character,
    // so \bapi_key\b fails to match in "my_api_key=secret". Adding _ - . to the boundary
    // class ensures compound keys like my_api_key, app.secret, my-token are matched.
    kvRegex: new RegExp(`(^|[\\s"'{(,;_\\-.])(${kvPattern})(\\s*[:=]\\s*)(["']?)([^\\s"']+)\\4`, "gi"),
    urlParamRegex: new RegExp(`([?&](?:${urlPattern})=)([^&\\s]+)`, "gi"),
    kvKeysLower: [...KV_BASE_KEYS, ...additionalKeys].map((k) => k.toLowerCase()),
  };
}

/** Regex to match credentials in connection strings (scheme://user:pass@host, including IPv6 [::1]) */
const CONN_STRING_REGEX = /:\/\/([^/:@\s[\]]+|\[[^\]]+\]):([^@\s]+)@/g;

/** Regex to match AWS access key IDs (AKIA followed by 16 uppercase alphanumeric characters) */
const AWS_KEY_REGEX = /AKIA[0-9A-Z]{16}/g;

/**
 * Regex to match a JSON string pair `"key": "value"`. The compiled KV_REGEX above
 * only matches `key=value` / `key: value` forms — the quote between key and colon
 * breaks its separator — so rendered JSON (`JSON.stringify` output in tool results)
 * needs its own pass. Key/value charsets exclude unescaped quotes, so the closing
 * delimiter is unambiguous (linear scan, no nested quantifiers).
 */
const JSON_KV_REGEX = /"([^"\\\n]+)"(\s*:\s*)"((?:[^"\\\n]|\\.)*)"/g;

/** Same for JSON embedded inside a JSON string, i.e. `\"key\": \"value\"`. */
const ESCAPED_JSON_KV_REGEX = /\\"([^"\\\n]+)\\"(\s*:\s*)\\"((?:[^"\\]|\\[^"])*)\\"/g;

/**
 * Configuration for a {@link SecretScrubber}.
 */
export interface SecretScrubberOptions {
  /**
   * Additional key-name fragments to treat as sensitive (case-insensitive
   * substring match). These bypass the shared blocklist since they are
   * explicitly declared sensitive by the consumer.
   */
  readonly additionalKeys?: readonly string[];
  /**
   * Exact key names (case-insensitive) that are never redacted by key-based
   * matching, even when they contain a sensitive fragment — e.g. `public_key`
   * matches the `key` fragment but is not a secret. Values of allowlisted keys
   * still pass through the string/value-shape scrubbing.
   *
   * Scope: applies wherever the FULL key name is known — object keys
   * (`scrubObject`) and JSON pairs in text. The flat-text `key=value` and
   * URL-param passes match only the sensitive fragment (never the full
   * compound key), so they may over-redact an allowlisted key there — the
   * safe direction. Explicit rules (`dropKeys`, `sensitivePaths`,
   * `maskWhenSibling`) are consumer declarations and win over `allowKeys`.
   */
  readonly allowKeys?: readonly string[];

  // ── Declarative domain rules (object contexts: scrubObject / JSON-parsed
  // content). Text renderings of the same data are covered via the value
  // collector — see `scrubObject`'s `collector` parameter. ─────────────────

  /**
   * Exact key names (case-insensitive) whose field is REMOVED entirely from
   * scrubbed objects — for fields that are both secret-bearing and bulky
   * (e.g. post-interpolation deploy artifacts). String leaves under a dropped
   * field are still reported to the collector so derived text can be purged.
   */
  readonly dropKeys?: readonly string[];

  /**
   * Dot-path suffixes (case-insensitive) whose value is masked — for keys
   * that are innocuous by NAME but secret in a specific CONTEXT (e.g.
   * `endpoint.params.url`: every alerter webhook URL is a secret, but `url`
   * alone must not be). Matched against the key path from the scrub root;
   * array elements keep their parent's path, so rules apply inside arrays.
   */
  readonly sensitivePaths?: readonly string[];

  /**
   * Mask the named sibling `keys` when the object's `sibling` field strictly
   * equals `equals` (default `true`) — for API shapes that carry their own
   * sensitivity flag (e.g. `{ is_secret: true, value: "..." }`). The `sibling`
   * flag key itself is implicitly allowlisted: it is a declared control field
   * (its value drives the rule), so the key-name heuristics never mask it.
   */
  readonly maskWhenSibling?: readonly { sibling: string; equals?: unknown; keys: readonly string[] }[];
}

/** Normalized (lowercased) form of a `maskWhenSibling` rule. */
interface SiblingRule {
  readonly sibling: string;
  readonly equals: unknown;
  readonly keys: ReadonlySet<string>;
}

/**
 * Masked/dropped string values shorter than this are NOT reported to the
 * collector — replacing tiny literals (e.g. `"1"`, `"on"`) in derived text
 * would corrupt unrelated content far more than it protects.
 */
const MIN_COLLECT_LENGTH = 4;

/**
 * Secret Scrubber class for detecting and redacting sensitive information.
 *
 * Usage:
 * - Create a scrubber: `const scrubber = new SecretScrubber();`
 * - Configure: `new SecretScrubber({ additionalKeys: ["fernet"], allowKeys: ["public_key"] })`
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

  /** Lowercased exact key names exempt from key-based redaction. */
  private readonly allowKeys: ReadonlySet<string>;

  /** Key-driven text patterns (KV + URL params), including `additionalKeys`. */
  private readonly patterns: CompiledKeyPatterns;

  /** Lowercased key names removed entirely from scrubbed objects. */
  private readonly dropKeys: ReadonlySet<string>;

  /** Lowercased dot-path suffixes whose value is masked. */
  private readonly sensitivePaths: readonly string[];

  /** Normalized sibling-conditioned masking rules. */
  private readonly siblingRules: readonly SiblingRule[];

  /**
   * Create a new SecretScrubber.
   * @param options - {@link SecretScrubberOptions}
   */
  constructor(options: SecretScrubberOptions = {}) {
    this.additionalKeys = options.additionalKeys ?? [];
    this.patterns = compileKeyPatterns(this.additionalKeys);
    this.dropKeys = new Set((options.dropKeys ?? []).map((k) => k.toLowerCase()));
    this.sensitivePaths = (options.sensitivePaths ?? []).map((p) => p.toLowerCase());
    this.siblingRules = (options.maskWhenSibling ?? []).map((r) => ({
      sibling: r.sibling,
      equals: r.equals ?? true,
      keys: new Set(r.keys.map((k) => k.toLowerCase())),
    }));
    // Sibling flag keys are implicitly allowlisted — they are declared control
    // fields (their value drives the rule), never secrets themselves.
    this.allowKeys = new Set([
      ...(options.allowKeys ?? []).map((k) => k.toLowerCase()),
      ...this.siblingRules.map((r) => r.sibling.toLowerCase()),
    ]);
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
    scrubbed = scrubbed.replace(this.patterns.urlParamRegex, `$1${REDACTED_VALUE}`);

    // 7. Context-based Scrubbing (Key-Value pairs)
    // Pre-check: skip expensive regex if no sensitive key substring is present
    const lowerScrubbed = scrubbed.toLowerCase();
    if (this.patterns.kvKeysLower.some((k) => lowerScrubbed.includes(k))) {
      scrubbed = scrubbed.replace(this.patterns.kvRegex, (match, prefix, key, sep, quote, value) => {
        // Don't redact if already redacted
        if (value.includes(REDACTED_VALUE)) return match;
        return `${prefix}${key}${sep}${quote}${REDACTED_VALUE}${quote}`;
      });
    }

    // 8. Rendered JSON (`"key": "value"`, plain and \"-escaped) — the KV pass above
    // can't match these (the quote between key and colon breaks its separator).
    // Callback-based so isSensitiveKey() applies, honoring additionalKeys/allowKeys.
    if (scrubbed.includes('"')) {
      scrubbed = scrubbed.replace(JSON_KV_REGEX, (m, key: string, sep: string, value: string) =>
        this.redactJsonPair(m, key, sep, value, '"'),
      );
      scrubbed = scrubbed.replace(ESCAPED_JSON_KV_REGEX, (m, key: string, sep: string, value: string) =>
        this.redactJsonPair(m, key, sep, value, '\\"'),
      );
    }

    return scrubbed;
  }

  /**
   * Redact one matched JSON string pair when its key is sensitive; return the
   * match unchanged otherwise (or when the value is already redacted).
   * `quote` is the pair's quote token — `"` for plain JSON, `\"` for JSON
   * embedded inside a JSON string.
   */
  private redactJsonPair(match: string, key: string, sep: string, value: string, quote: '"' | '\\"'): string {
    if (value.includes(REDACTED_VALUE) || !this.isSensitiveKey(key)) return match;
    return `${quote}${key}${quote}${sep}${quote}${REDACTED_VALUE}${quote}`;
  }

  /**
   * Recursively scrub sensitive keys from an object.
   *
   * Applies, in order per key: `dropKeys` (field removed), `maskWhenSibling`
   * and `sensitivePaths` (value masked), then the key-name heuristics
   * (`isSensitiveKey`); plain string values are scrubbed for embedded secrets
   * (e.g., "password=secret123" patterns).
   *
   * @param obj - The object to scrub
   * @param collector - Optional sink receiving every masked/dropped string
   *   leaf (length ≥ {@link MIN_COLLECT_LENGTH}). Callers use it to purge the
   *   same literals from TEXT derived from this object (e.g. a rendered tool
   *   result), where object-level rules cannot reach.
   * @returns A new object with sensitive values redacted
   */
  public scrubObject(obj: unknown, collector?: Set<string>): unknown {
    return this.scrubObjectRecursive(obj, new WeakSet(), "", collector);
  }

  /** Report a masked/dropped leaf value to the collector (strings only, min length). */
  private collect(value: unknown, collector: Set<string> | undefined): void {
    if (collector && typeof value === "string" && value.length >= MIN_COLLECT_LENGTH) {
      collector.add(value);
    }
  }

  /** Collect every string leaf of a dropped subtree (circular-safe). */
  private collectLeaves(value: unknown, visited: WeakSet<object>, collector: Set<string> | undefined): void {
    if (!collector) return;
    if (typeof value === "string") {
      this.collect(value, collector);
      return;
    }
    if (typeof value !== "object" || value === null || visited.has(value)) return;
    visited.add(value);
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      this.collectLeaves(child, visited, collector);
    }
  }

  /** Whether the (lowercased) key path from the scrub root matches a `sensitivePaths` rule. */
  private matchesSensitivePath(pathLower: string): boolean {
    return this.sensitivePaths.some((p) => pathLower === p || pathLower.endsWith(`.${p}`));
  }

  /**
   * Internal recursive scrub with circular reference protection and key-path
   * tracking (array elements keep their parent's path, so path rules apply
   * inside arrays).
   */
  private scrubObjectRecursive(
    obj: unknown,
    visited: WeakSet<object>,
    path: string,
    collector: Set<string> | undefined,
  ): unknown {
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
      return obj.map((item) => this.scrubObjectRecursive(item, visited, path, collector));
    }

    const redacted: Record<string, unknown> = {};
    // @type-narrowing — After null-check and Array.isArray, obj is a plain object; TS cannot narrow unknown to Record
    const objRecord = obj as Record<string, unknown>;

    // Sibling-conditioned masking: which keys of THIS object are masked by an
    // active rule (e.g. mask `value` when `is_secret === true`)?
    let siblingMasked: ReadonlySet<string> | undefined;
    for (const rule of this.siblingRules) {
      if (objRecord[rule.sibling] === rule.equals) {
        siblingMasked = siblingMasked ? new Set([...siblingMasked, ...rule.keys]) : rule.keys;
      }
    }

    for (const key in objRecord) {
      if (!Object.prototype.hasOwnProperty.call(objRecord, key)) continue;
      const keyLower = key.toLowerCase();
      const value = objRecord[key];

      // 1. Dropped fields disappear entirely (leaves still reach the collector).
      if (this.dropKeys.has(keyLower)) {
        this.collectLeaves(value, visited, collector);
        continue;
      }

      // 2. Explicit masking rules: sibling-conditioned or path-scoped.
      const childPath = path ? `${path}.${keyLower}` : keyLower;
      if (siblingMasked?.has(keyLower) === true || this.matchesSensitivePath(childPath)) {
        this.collect(value, collector);
        redacted[key] = REDACTED_VALUE;
        continue;
      }

      // 3. Key-name heuristics and recursion.
      if (this.isSensitiveKey(key)) {
        this.collect(value, collector);
        redacted[key] = REDACTED_VALUE;
      } else if (typeof value === "object") {
        redacted[key] = this.scrubObjectRecursive(value, visited, childPath, collector);
      } else if (typeof value === "string") {
        redacted[key] = this.scrub(value);
      } else {
        redacted[key] = value;
      }
    }

    return redacted;
  }

  /**
   * Check if a key is sensitive.
   *
   * Allowlisted keys (exact, case-insensitive) are never sensitive — checked
   * first so consumer exemptions like `public_key` beat every heuristic.
   * Otherwise delegates to the shared utility for base sensitive keys
   * (including blocklist logic). Additional keys provided at construction are
   * checked separately — they bypass the blocklist since they are explicitly
   * declared as sensitive by the consumer.
   *
   * @param key - The key to check
   * @returns true if the key matches a sensitive pattern
   */
  public isSensitiveKey(key: string): boolean {
    // Consumer allowlist wins over every heuristic (exact match only, so an
    // allowlist entry like "key" can never exempt "api_key" wholesale).
    if (this.allowKeys.has(key.toLowerCase())) return false;

    // Delegate to shared utility for base sensitive keys (includes blocklist)
    if (baseSensitiveKeyCheck(key)) return true;

    // Check additional keys — explicitly provided, no blocklist needed
    if (this.additionalKeys.length === 0) return false;
    const lowerKey = key.toLowerCase();
    return this.additionalKeys.some((ak) => lowerKey.includes(ak.toLowerCase()));
  }
}

/**
 * Consumer-facing scrubbing configuration, shared by every framework surface
 * that accepts one (tool-result boundary, dynamic-resource registry):
 * - `undefined` / `true` → scrub with the base heuristics
 * - `false` → disable scrubbing entirely
 * - options object → scrub with `additionalKeys` / `allowKeys` applied
 */
export type SecretScrubberConfig = boolean | SecretScrubberOptions;

/**
 * Build a `SecretScrubber` from a {@link SecretScrubberConfig}. Returns
 * `undefined` when scrubbing is disabled — callers skip their scrub stage
 * entirely in that case.
 */
export function createSecretScrubber(config: SecretScrubberConfig | undefined): SecretScrubber | undefined {
  if (config === false) return undefined;
  if (config === true || config === undefined) return new SecretScrubber();
  return new SecretScrubber(config);
}

/**
 * Default secret scrubber instance.
 */
export const secretScrubber = new SecretScrubber();

/**
 * Scrub string content by declared mimeType — shared by every registry that stores
 * content ahead of read time (dynamic and static resources).
 *
 * JSON content is scrubbed AS AN OBJECT (parse → `scrubObject` → re-stringify), so
 * declarative rules (`dropKeys`, `sensitivePaths`, `maskWhenSibling`) apply with full
 * structural fidelity — text regexes could never drop a nested field. Unparseable or
 * non-JSON content falls back to the text scrub.
 */
export function scrubByMimeType(content: string, mimeType: string, scrubber: SecretScrubber): string {
  if (mimeType.toLowerCase().includes("json")) {
    try {
      return JSON.stringify(scrubber.scrubObject(JSON.parse(content)), null, 2);
    } catch {
      // Declared JSON but doesn't parse — treat as text below.
    }
  }
  return scrubber.scrub(content);
}
