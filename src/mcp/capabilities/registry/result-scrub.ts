/**
 * Tool-Result Secret Scrubbing
 *
 * The single choke point for redacting secrets from tool output: every
 * `CallToolResult` — regular tools and task tools alike — passes through
 * {@link scrubCallToolResult} before it returns to the SDK (and from there to
 * the client transcript and the model provider).
 *
 * Fail-closed by design: if scrubbing itself fails, the result is withheld and
 * replaced by a generic error — an unscrubbed result never leaves the server.
 *
 * Binary payloads (`image`/`audio` `data`, embedded-resource `blob`) pass
 * through verbatim: value-shape regexes can legitimately match inside base64
 * and would corrupt the payload. Unknown/future content-block types are
 * scrubbed as objects — a corrupted hypothetical binary field is a visible,
 * safe failure; a leaked future text field would be a silent one.
 *
 * Resources are covered by two sibling scrub stages, not this one: the static
 * `ResourceRegistry` scrubs string content on read (`resultScrubber` in
 * `ResourceBindOptions`), the ephemeral `DynamicResourceRegistry` scrubs on
 * register — both needed because `resources/read` bypasses this tool-result
 * boundary entirely.
 *
 * @module mcp/capabilities/registry/result-scrub
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "../../../logger/index.js";
import { ScrubberError } from "../../../logger/core/index.js";
import { SecretScrubber, createSecretScrubber, REDACTED_VALUE } from "../../../utils/scrubbing/index.js";
import type { SecretScrubberConfig } from "../../../utils/scrubbing/index.js";

/**
 * Consumer-facing configuration for tool-result scrubbing — the shared
 * {@link SecretScrubberConfig} shape under its `createServer`-option name.
 */
export type ScrubToolResultsConfig = SecretScrubberConfig;

/**
 * Build the per-server `SecretScrubber` from the consumer-facing config —
 * the shared `createSecretScrubber` factory under its tool-result name.
 * Returns `undefined` when scrubbing is disabled.
 */
export const createResultScrubber = createSecretScrubber;

/**
 * Purge known secret literals from text — values the object-level scrub
 * masked/dropped in `structuredContent`. Text content is RENDERED from the
 * same raw data before the boundary runs, so object rules (paths, sibling
 * flags, dropped fields) can only reach it via this literal replacement.
 * Longest-first so an overlapping shorter literal never splits a longer one.
 * Each literal is also matched in its JSON-escaped form — `JSON.stringify`
 * renderings escape newlines/quotes, so a multi-line value appears in text
 * as `line1\nline2`, not with real newlines.
 */
function purgeLiterals(text: string, literals: ReadonlySet<string>, redactedValue: string): string {
  if (literals.size === 0) return text;
  const forms = new Set<string>();
  for (const literal of literals) {
    forms.add(literal);
    const jsonEscaped = JSON.stringify(literal).slice(1, -1);
    if (jsonEscaped !== literal) forms.add(jsonEscaped);
  }
  let purged = text;
  for (const form of [...forms].sort((a, b) => b.length - a.length)) {
    if (purged.includes(form)) purged = purged.split(form).join(redactedValue);
  }
  return purged;
}

/**
 * Scrub a single content block. String-bearing fields are scrubbed (heuristics
 * + purge of collected literals); binary fields (`data`, `blob`) pass through
 * verbatim.
 */
function scrubContentBlock(
  block: CallToolResult["content"][number],
  scrubber: SecretScrubber,
  literals: ReadonlySet<string>,
): CallToolResult["content"][number] {
  const scrubText = (text: string): string => purgeLiterals(scrubber.scrub(text), literals, REDACTED_VALUE);
  switch (block.type) {
    case "text":
      return { ...block, text: scrubText(block.text) };
    case "resource": {
      const resource =
        "text" in block.resource && typeof block.resource.text === "string"
          ? { ...block.resource, text: scrubText(block.resource.text) }
          : block.resource; // blob variant — binary, pass through
      return { ...block, resource };
    }
    case "resource_link":
      return {
        ...block,
        uri: scrubText(block.uri),
        name: scrubText(block.name),
        ...(block.description !== undefined && { description: scrubText(block.description) }),
        ...(block.title !== undefined && { title: scrubText(block.title) }),
      };
    case "image":
    case "audio":
      // Binary payloads pass through verbatim (base64 corruption risk).
      return block;
    default:
      // Unknown/future block types: scrub as an object rather than passing
      // verbatim — fail-closed, consistent with this module's contract.
      return scrubber.scrubObject(block) as CallToolResult["content"][number];
  }
}

/**
 * Scrub secrets from a complete `CallToolResult` (including `isError` results —
 * upstream error messages embed API responses).
 *
 * Never throws. On any scrub failure the original result is withheld and a
 * generic `isError` result is returned instead, carrying zero fragments of the
 * original content or the scrub error (fail-closed).
 */
export function scrubCallToolResult(
  result: CallToolResult,
  scrubber: SecretScrubber,
  logger: Logger,
  toolName: string,
): CallToolResult {
  try {
    // Structured content first: the object-level scrub collects the concrete
    // values it masked/dropped, and the text blocks — rendered from the same
    // raw data in the handler — are purged of exactly those literals below.
    const literals = new Set<string>();
    const structuredContent =
      result.structuredContent !== undefined
        ? (scrubber.scrubObject(result.structuredContent, literals) as Record<string, unknown>)
        : undefined;
    return {
      ...result,
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive at the SDK result boundary; content may be absent at runtime.
      content: (result.content ?? []).map((block) => scrubContentBlock(block, scrubber, literals)),
      ...(structuredContent !== undefined && { structuredContent }),
    };
  } catch (error) {
    const scrubError = new ScrubberError(`Tool [${toolName}] result scrub failed`, {
      cause: error instanceof Error ? error : undefined,
      context: { toolName },
    });
    logger.error("Tool [%s] result scrub failed — withholding result", toolName, scrubError);
    return {
      isError: true,
      content: [{ type: "text", text: "Tool result withheld: secret redaction failed (see server logs)." }],
    };
  }
}
