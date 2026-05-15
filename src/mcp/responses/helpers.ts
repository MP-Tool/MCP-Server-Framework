/**
 * Response Helpers
 *
 * Factory functions for creating MCP tool responses with zero boilerplate.
 * These helpers produce properly formatted CallToolResult objects.
 *
 * @module mcp/responses/helpers
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type {
  TextResponseOptions,
  JsonResponseOptions,
  StructuredResponseOptions,
  ErrorResponseOptions,
  ImageResponseOptions,
  AudioResponseOptions,
  ContentAnnotations,
  ResourceLinkSpec,
  ResponseOptions,
} from "../types/index.js";

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Build a `resource_link` content item from a {@link ResourceLinkSpec}.
 */
function buildResourceLinkItem(spec: ResourceLinkSpec): CallToolResult["content"][number] {
  return withAnnotations(
    {
      type: "resource_link" as const,
      uri: spec.uri,
      name: spec.name,
      ...(spec.mimeType !== undefined && { mimeType: spec.mimeType }),
      ...(spec.description !== undefined && { description: spec.description }),
      ...(spec.title !== undefined && { title: spec.title }),
    },
    spec.annotations,
  );
}

/**
 * Build a CallToolResult from content items and options.
 * Centralizes the repeated annotations + _meta wrapping pattern.
 */
function buildResponse(
  content: CallToolResult["content"],
  options?: ResponseOptions & { isError?: boolean },
): CallToolResult {
  const fullContent = options?.links?.length ? [...content, ...options.links.map(buildResourceLinkItem)] : content;
  return {
    content: fullContent,
    ...(options?.isError && { isError: true }),
    ...(options?._meta && { _meta: options._meta }),
    ...(options?.structuredContent && { structuredContent: options.structuredContent }),
  };
}

/**
 * Spread annotations onto a content item if provided.
 */
function withAnnotations<T extends Record<string, unknown>>(item: T, annotations?: ContentAnnotations): T {
  if (!annotations) return item;
  return { ...item, annotations: { ...annotations } };
}

// ============================================================================
// Text Response
// ============================================================================

/**
 * Create a text response.
 *
 * This is the most common response type for tool results.
 *
 * @param content - The text content to return
 * @param options - Optional annotations and metadata
 * @returns A CallToolResult with text content
 *
 * @example
 * ```typescript
 * // Simple text response
 * return text('Hello, World!');
 *
 * // With annotations
 * return text('Secret message', {
 *   annotations: { audience: ['user'] },
 * });
 * ```
 */
export function text(content: string, options?: TextResponseOptions): CallToolResult {
  return buildResponse([withAnnotations({ type: "text" as const, text: content }, options?.annotations)], options);
}

// ============================================================================
// JSON Response
// ============================================================================

/**
 * Create a JSON response.
 *
 * Automatically serializes the data with pretty-printing.
 * Useful for returning structured data from tools.
 *
 * @param data - The data to serialize as JSON
 * @param options - Optional formatting, annotations, and metadata
 * @returns A CallToolResult with JSON text content
 *
 * @example
 * ```typescript
 * // Simple JSON response
 * return json({ status: 'ok', count: 42 });
 *
 * // Compact JSON (no indentation)
 * return json(data, { indent: 0 });
 * ```
 */
export function json(data: unknown, options?: JsonResponseOptions): CallToolResult {
  const indent = options?.indent ?? 2;

  let serialized: string;
  try {
    serialized = JSON.stringify(data, null, indent);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "JSON serialization failed";
    return error(`Failed to serialize response as JSON: ${msg}`, options);
  }

  return buildResponse([withAnnotations({ type: "text" as const, text: serialized }, options?.annotations)], options);
}

// ============================================================================
// Structured Response
// ============================================================================

/**
 * Create a spec-compliant structured response for tools that declare an
 * `output` schema.
 *
 * Per MCP 2025-06-18 ("Structured Content"), tools that return
 * `structuredContent` SHOULD also serialize the same payload into a
 * `TextContent` block for backwards compatibility with clients that do not
 * yet read `outputSchema` / `structuredContent`. Modern clients prefer
 * `structuredContent` for typed access while the `TextContent` block stays
 * available for display-oriented rendering and legacy consumers.
 *
 * By default the helper serializes `data` as pretty-printed JSON into the
 * `TextContent` block — a safe, schema-faithful fallback. Pass
 * {@link StructuredResponseOptions.text | options.text} to override the
 * `TextContent` with a human-readable rendering (Markdown, ASCII table,
 * etc.). The `structuredContent` payload remains the single source of
 * truth in either case.
 *
 * For tools without an output schema (state-change confirmations, free-form
 * messages), use {@link text} instead.
 *
 * @param data - The structured payload (must conform to the tool's output schema)
 * @param options - Optional `text` override, indent (default 2), annotations, and metadata
 * @returns A CallToolResult with both `structuredContent` and a `TextContent` block
 *
 * @example JSON fallback (default)
 * ```typescript
 * defineTool({
 *   name: 'my_tool',
 *   output: mySchema,
 *   handler: async () => {
 *     const result = { ok: true, count: 42 };
 *     return structured(result);
 *   },
 * });
 * ```
 *
 * @example Custom Markdown rendering for UI clients
 * ```typescript
 * defineTool({
 *   name: 'list_items',
 *   output: listSchema,
 *   handler: async () => {
 *     const payload = { items: [...] };
 *     return structured(payload, {
 *       text: `### Items (${payload.items.length})\n\n${renderTable(payload.items)}`,
 *     });
 *   },
 * });
 * ```
 */
export function structured(data: unknown, options?: StructuredResponseOptions): CallToolResult {
  let displayText: string;
  if (options?.text !== undefined) {
    displayText = options.text;
  } else {
    const indent = options?.indent ?? 2;
    try {
      displayText = JSON.stringify(data, null, indent);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "JSON serialization failed";
      return error(`Failed to serialize structured response: ${msg}`, options);
    }
  }

  return buildResponse([withAnnotations({ type: "text" as const, text: displayText }, options?.annotations)], {
    ...options,
    structuredContent: data as Record<string, unknown>,
  });
}

// ============================================================================
// Error Response
// ============================================================================

/**
 * Create an error response.
 *
 * Sets the isError flag to indicate the tool execution failed.
 * Use this for user-friendly error messages.
 *
 * @param message - The error message to return
 * @param options - Optional annotations and metadata
 * @returns A CallToolResult with isError=true
 *
 * @example
 * ```typescript
 * // Simple error
 * return error('Container not found');
 *
 * // With annotations
 * return error('Permission denied', {
 *   annotations: { audience: ['user'] },
 * });
 * ```
 */
export function error(message: string, options?: ErrorResponseOptions): CallToolResult {
  return buildResponse([withAnnotations({ type: "text" as const, text: message }, options?.annotations)], {
    ...options,
    isError: true,
  });
}

// ============================================================================
// Image Response
// ============================================================================

/**
 * Create an image response.
 *
 * The data must be base64-encoded image data.
 *
 * @param data - Base64-encoded image data
 * @param options - MIME type and optional annotations
 * @returns A CallToolResult with image content
 *
 * @example
 * ```typescript
 * // PNG image (default)
 * return image(base64Data);
 *
 * // JPEG image
 * return image(base64Data, { mimeType: 'image/jpeg' });
 * ```
 */
export function image(data: string, options?: ImageResponseOptions): CallToolResult {
  const mimeType = options?.mimeType ?? "image/png";

  return buildResponse([withAnnotations({ type: "image" as const, data, mimeType }, options?.annotations)], options);
}

// ============================================================================
// Audio Response
// ============================================================================

/**
 * Create an audio response.
 *
 * The data must be base64-encoded audio data.
 *
 * @param data - Base64-encoded audio data
 * @param options - MIME type and optional annotations
 * @returns A CallToolResult with audio content
 *
 * @example
 * ```typescript
 * // WAV audio (default)
 * return audio(base64Data);
 *
 * // MP3 audio
 * return audio(base64Data, { mimeType: 'audio/mp3' });
 * ```
 */
export function audio(data: string, options?: AudioResponseOptions): CallToolResult {
  const mimeType = options?.mimeType ?? "audio/wav";

  return buildResponse([withAnnotations({ type: "audio" as const, data, mimeType }, options?.annotations)], options);
}

// ============================================================================
// Multi-Content Response
// ============================================================================

/**
 * Create a response with multiple content items.
 *
 * Useful for returning text alongside images or multiple text blocks.
 *
 * @param items - Array of text, image, and/or audio content
 * @param options - Optional metadata
 * @returns A CallToolResult with multiple content items
 *
 * @example
 * ```typescript
 * return multi([
 *   { type: 'text', text: 'Here is the chart:' },
 *   { type: 'image', data: chartBase64, mimeType: 'image/png' },
 * ]);
 * ```
 */
export function multi(
  items: Array<
    | { type: "text"; text: string; annotations?: ContentAnnotations }
    | {
        type: "image";
        data: string;
        mimeType: string;
        annotations?: ContentAnnotations;
      }
    | {
        type: "audio";
        data: string;
        mimeType: string;
        annotations?: ContentAnnotations;
      }
  >,
  options?: { _meta?: Record<string, unknown>; links?: readonly ResourceLinkSpec[] },
): CallToolResult {
  if (items.length === 0) {
    throw new TypeError("multi() requires at least one content item");
  }
  return buildResponse(
    items.map((item) => withAnnotations({ ...item }, item.annotations)),
    options,
  );
}

// ============================================================================
// Resource Link Response
// ============================================================================

/**
 * Create a response that consists of a single `resource_link` content block.
 *
 * Tools that point at large or out-of-band payloads (logs, inspect dumps,
 * compose files) emit a resource link instead of inlining the payload.
 * Clients call `resources/read` with the URI to retrieve the content.
 *
 * For most tools, prefer attaching links via the `links` option of
 * {@link text}, {@link json} or {@link structured} so the response keeps a
 * human-readable summary alongside the link. Use this helper when the link
 * is the entire response.
 *
 * @param spec - Resource link specification (URI, name, optional MIME / description / title)
 * @param options - Optional metadata, annotations, structured content
 * @returns A CallToolResult containing a single `resource_link` content block
 *
 * @example
 * ```typescript
 * return resourceLink({
 *   uri: 'ephemeral://logs/abc123',
 *   name: 'container.log',
 *   mimeType: 'text/plain',
 * });
 * ```
 */
export function resourceLink(spec: ResourceLinkSpec, options?: ResponseOptions): CallToolResult {
  return buildResponse([buildResourceLinkItem(spec)], options);
}
