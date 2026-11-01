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
  isNumericMetadataKey,
} from "../sensitive-keys.js";
import { scrubTomlContent } from "./scrub-toml.js";

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
    // The separator accepts a closing single quote (`'x-api-key': ...`, as util.inspect prints
    // objects). Double-quoted keys are JSON and belong to the JSON passes, which know booleans.
    // A quoted value runs to its closing quote, spaces included; without one, an opening quote
    // still counts as value, so an unterminated quote cannot hide a secret from the match.
    kvRegex: new RegExp(
      `(^|[\\s"'{(,;_\\-.])(${kvPattern})('?\\s*[:=]\\s*)("[^"\\n]+"|'[^'\\n]+'|["']?[^\\s"]+)`,
      "gi",
    ),
    urlParamRegex: new RegExp(`([?&](?:${urlPattern})=)([^&\\s]+)`, "gi"),
    kvKeysLower: [...KV_BASE_KEYS, ...additionalKeys].map((k) => k.toLowerCase()),
  };
}

/** Characters that continue an identifier when widening a matched key fragment. */
const KEY_CHAR = /[A-Za-z0-9_.-]/;

/**
 * Widen a matched sensitive fragment to the full compound key around it.
 *
 * The KV pattern matches only the fragment (`secret` inside `is_secret`), but
 * `allowKeys` is an EXACT-name contract — it can only be honored against the
 * whole key. A linear character scan over identifier characters is enough and,
 * unlike widening the regex itself, carries no backtracking cost.
 *
 * @param text - The string being scrubbed
 * @param start - Index where the matched fragment begins
 * @param length - Length of the matched fragment
 * @returns The surrounding compound key, lowercased
 */
function expandKey(text: string, start: number, length: number): string {
  let from = start;
  while (from > 0 && KEY_CHAR.test(text[from - 1] as string)) from--;
  let to = start + length;
  while (to < text.length && KEY_CHAR.test(text[to] as string)) to++;
  return text.slice(from, to).toLowerCase();
}

/**
 * Mask URL credentials: `scheme://user:pass@host` (the user may be empty, and the password may
 * contain `@`, so it runs to the last `@` of the token), IPv6 `scheme://[::1]:pass@host`, and
 * `scheme://token@host`. A token ends at whitespace or a quote.
 *
 * A scan rather than a regex: a pattern that looks ahead for `@` restarts at every `://`, which
 * takes minutes on hostile input such as `://a:` repeated, and this runs on every log line.
 * Each token's end and last `@` are computed once, so the scan is linear.
 */
function scrubUrlCredentials(text: string): string {
  let out = "";
  let copied = 0;
  let searchFrom = 0;
  let tokenEnd = -1;
  let lastAt = -1;

  for (;;) {
    const scheme = text.indexOf("://", searchFrom);
    if (scheme === -1) return copied === 0 ? text : out + text.slice(copied);
    const start = scheme + 3;

    if (start >= tokenEnd) {
      tokenEnd = start;
      while (tokenEnd < text.length && !/[\s"']/.test(text[tokenEnd] as string)) tokenEnd++;
      lastAt = text.lastIndexOf("@", tokenEnd - 1);
    }
    // No credentials anywhere in the rest of this token, nested URLs included.
    if (lastAt < start) {
      searchFrom = tokenEnd;
      continue;
    }

    // Where the user part ends: `[...]` is an IPv6 host, otherwise the first `:`, `/` or `@`.
    let cursor = start;
    if (text[cursor] === "[") cursor = text.indexOf("]", cursor) + 1 || tokenEnd;
    while (cursor < tokenEnd && !":/@".includes(text[cursor] as string)) cursor++;

    if (text[cursor] === "@") {
      out += `${text.slice(copied, start)}${REDACTED_VALUE}`;
      copied = cursor;
      searchFrom = cursor;
    } else if (text[cursor] === ":") {
      out += `${text.slice(copied, cursor + 1)}${REDACTED_VALUE}`;
      copied = lastAt;
      searchFrom = lastAt;
    } else {
      // A path before any credential: only a URL nested further on can still have one.
      searchFrom = cursor;
    }
  }
}

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

/** A JSON number pair, `"key": 123`. Only numbers: booleans and null cannot hold a secret. */
const JSON_NUMBER_REGEX = /"([^"\\\n]+)"(\s*:\s*)(-?\d[\d.eE+-]*)(?=\s*(?:[,}\]]|$))/gm;

/** Same for JSON embedded inside a JSON string, i.e. `\"key\": 123`. */
const ESCAPED_JSON_NUMBER_REGEX = /\\"([^"\\\n]+)\\"(\s*:\s*)(-?\d[\d.eE+-]*)(?=\s*(?:[,}\]]|$))/gm;

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
   * Scope: object keys (`scrubObject`), JSON pairs in text, and the flat-text
   * `key=value` pass — the last one widens its matched fragment to the
   * surrounding compound key so exact allowlist entries apply there too
   * (`is_secret = true` stays a boolean, in prose and in query strings alike).
   *
   * One narrow exception: the URL-query-parameter pass runs first and matches
   * bare base names, so a query parameter named exactly like a base sensitive
   * key is redacted even when allowlisted — `?secret=x` stays masked while
   * `secret=x` in plain text does not. Over-redaction, i.e. the safe direction.
   *
   * Explicit rules (`dropKeys`, `sensitivePaths`, `maskWhenSibling`) are
   * consumer declarations and win over `allowKeys`.
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
 * Per-walk traversal state for {@link SecretScrubber.scrubObject}.
 *
 * Created fresh for every call — a scrubber instance is long-lived and its
 * inputs may be mutated between calls, so nothing here may outlive one walk.
 */
interface ScrubTraversalState {
  /** Nodes on the current path; membership means a genuine cycle. */
  readonly ancestors: WeakSet<object>;
  /** Already-scrubbed results per node, keyed by the path scope that produced them. */
  readonly memo: WeakMap<object, Map<string, unknown>>;
  /** Mask without changing a value's type; see {@link SecretScrubber.scrubStructured}. */
  readonly preserveTypes: boolean;
}

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
   * How many trailing segments of a node's own path can still affect its subtree.
   *
   * `sensitivePaths` are matched as suffixes, so the deepest a rule can reach
   * from a node is the node's path plus one more key — meaning only the last
   * `longestRule - 1` segments above it can complete a rule. Everything further
   * up is irrelevant to the node's result. With no path rules configured this is
   * `0`: the path cannot influence anything, and results depend on the node alone.
   *
   * This is what makes the per-walk memo in `scrubObjectRecursive` sound.
   */
  private readonly pathScopeSegments: number;

  /**
   * Create a new SecretScrubber.
   * @param options - {@link SecretScrubberOptions}
   */
  constructor(options: SecretScrubberOptions = {}) {
    this.additionalKeys = options.additionalKeys ?? [];
    this.patterns = compileKeyPatterns(this.additionalKeys);
    this.dropKeys = new Set((options.dropKeys ?? []).map((k) => k.toLowerCase()));
    this.sensitivePaths = (options.sensitivePaths ?? []).map((p) => p.toLowerCase());
    this.pathScopeSegments = Math.max(0, ...this.sensitivePaths.map((p) => p.split(".").length - 1));
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
    scrubbed = scrubUrlCredentials(scrubbed);

    // 6. Sensitive URL query parameters - "?password=xxx&api_key=yyy"
    scrubbed = scrubbed.replace(this.patterns.urlParamRegex, `$1${REDACTED_VALUE}`);

    // 7. Context-based Scrubbing (Key-Value pairs)
    // Pre-check: skip expensive regex if no sensitive key substring is present
    const lowerScrubbed = scrubbed.toLowerCase();
    if (this.patterns.kvKeysLower.some((k) => lowerScrubbed.includes(k))) {
      scrubbed = scrubbed.replace(
        this.patterns.kvRegex,
        (match: string, prefix: string, key: string, sep: string, value: string, offset: number, whole: string) => {
          // Don't redact if already redacted
          if (value.includes(REDACTED_VALUE)) return match;
          // The pattern matches the sensitive FRAGMENT (`secret` inside `is_secret`).
          // Widen it to the surrounding compound key so an allowlisted name is
          // honored here too — otherwise `is_secret = true` gets masked into a
          // string, which is both wrong and enough to break a config document.
          const fullKey = expandKey(whole, offset + prefix.length, key.length);
          if (this.allowKeys.has(fullKey)) return match;
          if (isNumericMetadataKey(fullKey) && !Number.isNaN(Number(value))) return match;
          const quote = /^(["']).*\1$/.test(value) ? (value[0] as string) : "";
          return `${prefix}${key}${sep}${quote}${REDACTED_VALUE}${quote}`;
        },
      );
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
      scrubbed = scrubbed.replace(JSON_NUMBER_REGEX, (m, key: string, sep: string) =>
        this.redactJsonNumber(m, key, sep, '"'),
      );
      scrubbed = scrubbed.replace(ESCAPED_JSON_NUMBER_REGEX, (m, key: string, sep: string) =>
        this.redactJsonNumber(m, key, sep, '\\"'),
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

  /** Redact one matched JSON number pair by the same rule as {@link maskLeaves}. */
  private redactJsonNumber(match: string, key: string, sep: string, quote: '"' | '\\"'): string {
    if (!this.isSensitiveKey(key) || isNumericMetadataKey(key)) return match;
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
    return this.scrubObjectRecursive(
      obj,
      { ancestors: new WeakSet(), memo: new WeakMap(), preserveTypes: false },
      "",
      collector,
    );
  }

  /**
   * Like {@link scrubObject}, but every masked value keeps its type: strings become the marker,
   * numbers `0`, booleans under an explicit rule `false`, and containers stay. For data validated
   * after scrubbing — the SDK checks `structuredContent` against the tool's output schema, and a
   * type mismatch would turn a successful call into an error. Logs and audit records use
   * {@link scrubObject}, where `0` would read like a real value.
   */
  public scrubStructured(obj: unknown, collector?: Set<string>): unknown {
    return this.scrubObjectRecursive(
      obj,
      { ancestors: new WeakSet(), memo: new WeakMap(), preserveTypes: true },
      "",
      collector,
    );
  }

  /** Report a masked/dropped leaf value to the collector (strings and numbers, min length). */
  private collect(value: unknown, collector: Set<string> | undefined): void {
    const literal = typeof value === "number" || typeof value === "bigint" ? String(value) : value;
    if (collector && typeof literal === "string" && literal.length >= MIN_COLLECT_LENGTH) {
      collector.add(literal);
    }
  }

  /**
   * Collect every leaf of a dropped or masked subtree (circular-safe).
   *
   * Walks with its OWN `seen` set rather than the caller's ancestor stack — a
   * dropped subtree is a side excursion, and marking its nodes on the main
   * traversal's stack would make a later, legitimate visit look circular.
   */
  private collectLeaves(
    value: unknown,
    collector: Set<string> | undefined,
    seen: WeakSet<object> = new WeakSet(),
  ): void {
    if (!collector) return;
    if (typeof value !== "object" || value === null) {
      this.collect(value, collector);
      return;
    }
    if (seen.has(value)) return;
    seen.add(value);
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      this.collectLeaves(child, collector, seen);
    }
  }

  /**
   * Mask what lies below a masked key, keeping containers and reporting what it masks to the
   * collector. Under the name heuristics (`explicit` false) booleans cannot hold a secret and
   * stay, and a number stays only when its key names metadata ({@link isNumericMetadataKey}).
   * An explicit rule masks both. Null stays either way; a circular reference is masked like a
   * leaf.
   */
  private maskLeaves(
    value: unknown,
    key: string,
    collector: Set<string> | undefined,
    mode: { readonly preserveTypes: boolean; readonly explicit: boolean },
    ancestors: WeakSet<object> = new WeakSet(),
  ): unknown {
    if (value === null) return value;
    if (typeof value === "boolean") return mode.explicit ? false : value;
    if (typeof value === "number") {
      if (!mode.explicit && isNumericMetadataKey(key)) return value;
      this.collect(value, collector);
      return mode.preserveTypes ? 0 : REDACTED_VALUE;
    }
    if (typeof value !== "object") {
      this.collect(value, collector);
      return REDACTED_VALUE;
    }
    if (ancestors.has(value)) return REDACTED_VALUE;
    ancestors.add(value);
    const masked = Array.isArray(value)
      ? value.map((item) => this.maskLeaves(item, key, collector, mode, ancestors))
      : Object.fromEntries(
          Object.entries(value).map(([childKey, item]) => [
            childKey,
            this.maskLeaves(item, childKey, collector, mode, ancestors),
          ]),
        );
    ancestors.delete(value);
    return masked;
  }

  /** Whether the (lowercased) key path from the scrub root matches a `sensitivePaths` rule. */
  private matchesSensitivePath(pathLower: string): boolean {
    return this.sensitivePaths.some((p) => pathLower === p || pathLower.endsWith(`.${p}`));
  }

  /**
   * The part of `path` that can still influence a node's subtree — its last
   * {@link pathScopeSegments} segments, and `""` when no path rules exist.
   * Two visits of the same node under the same scope must produce the same
   * result, which is exactly the memo key used below.
   */
  private pathScope(path: string): string {
    if (this.pathScopeSegments === 0) return "";
    return path.split(".").slice(-this.pathScopeSegments).join(".");
  }

  /**
   * Internal recursive scrub with circular reference protection and key-path
   * tracking (array elements keep their parent's path, so path rules apply
   * inside arrays).
   *
   * Two structures do the work:
   *
   * - `ancestors` holds only the nodes on the CURRENT path, so a genuine cycle
   *   is caught while a value merely referenced twice — a diamond, e.g. the same
   *   tag object on two resources — is not mistaken for one.
   * - `memo` remembers each node's scrubbed result, keyed by node and
   *   {@link pathScope}. Without it, a node reachable by K paths would be
   *   recomputed K times and a chain of shared references would cost time
   *   exponential in its depth; with it every distinct (node, scope) pair is
   *   computed once, so the walk is linear in the size of the graph.
   *
   * Repeated references therefore share one result object. That is safe here —
   * results are serialized, never mutated — and it is what keeps the walk
   * linear. One deliberate imprecision: a node first reached from inside a
   * cycle records the `"[Circular]"` marker its own walk produced, and reuses
   * it if reached again from outside that cycle. The marker only ever removes
   * information, so this errs towards less exposure, never more.
   */
  private scrubObjectRecursive(
    obj: unknown,
    state: ScrubTraversalState,
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

    // Value objects that serialize to a primitive (Date — and therefore
    // smol-toml's TomlDate) carry no scrubbable keys. Walking them as plain
    // records would erase them to `{}`, so hand them back untouched.
    if (obj instanceof Date) {
      return obj;
    }

    // Circular reference protection — prevent stack overflow
    if (state.ancestors.has(obj)) {
      return "[Circular]";
    }

    const scope = this.pathScope(path);
    const byScope = state.memo.get(obj);
    if (byScope?.has(scope) === true) {
      return byScope.get(scope);
    }

    state.ancestors.add(obj);
    let result: unknown;
    try {
      result = this.scrubObjectNode(obj, state, path, collector);
    } finally {
      state.ancestors.delete(obj);
    }

    if (byScope === undefined) {
      state.memo.set(obj, new Map([[scope, result]]));
    } else {
      byScope.set(scope, result);
    }
    return result;
  }

  /** Scrub one already-cycle-checked array/object node. See {@link scrubObjectRecursive}. */
  private scrubObjectNode(
    obj: object,
    state: ScrubTraversalState,
    path: string,
    collector: Set<string> | undefined,
  ): unknown {
    if (Array.isArray(obj)) {
      return obj.map((item) => this.scrubObjectRecursive(item, state, path, collector));
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
        this.collectLeaves(value, collector);
        continue;
      }

      // 2. Explicit masking rules: sibling-conditioned or path-scoped.
      const childPath = path ? `${path}.${keyLower}` : keyLower;
      if (siblingMasked?.has(keyLower) === true || this.matchesSensitivePath(childPath)) {
        if (state.preserveTypes) {
          redacted[key] = this.maskLeaves(value, key, collector, { preserveTypes: true, explicit: true });
        } else {
          this.collectLeaves(value, collector);
          redacted[key] = REDACTED_VALUE;
        }
        continue;
      }

      // 3. Key-name heuristics and recursion.
      if (this.isSensitiveKey(key)) {
        redacted[key] = this.maskLeaves(value, key, collector, {
          preserveTypes: state.preserveTypes,
          explicit: false,
        });
      } else if (typeof value === "object") {
        redacted[key] = this.scrubObjectRecursive(value, state, childPath, collector);
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
 * STRUCTURED formats are scrubbed AS OBJECTS (parse → `scrubObject` → re-serialize),
 * so declarative rules (`dropKeys`, `sensitivePaths`, `maskWhenSibling`) apply with
 * full structural fidelity — text regexes could never drop a nested field, and they
 * over-redact allowlisted keys whose NAME contains a sensitive fragment. Recognized
 * by mimeType substring: `json` and `toml`. Unparseable content, and every other
 * type, falls back to the text scrub.
 *
 * Registering structured content under `text/plain` therefore silently downgrades it
 * to regex redaction — declare the real type.
 */
export function scrubByMimeType(content: string, mimeType: string, scrubber: SecretScrubber): string {
  const type = mimeType.toLowerCase();
  if (type.includes("json")) {
    try {
      return JSON.stringify(scrubber.scrubObject(JSON.parse(content)), null, 2);
    } catch {
      // Declared JSON but doesn't parse — treat as text below.
    }
  }
  if (type.includes("toml")) {
    return scrubTomlContent(content, scrubber);
  }
  return scrubber.scrub(content);
}
