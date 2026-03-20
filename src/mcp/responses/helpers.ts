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
  ErrorResponseOptions,
  ImageResponseOptions,
  AudioResponseOptions,
  ContentAnnotations,
  ResponseOptions,
} from "../types/index.js";

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Build a CallToolResult from content items and options.
 * Centralizes the repeated annotations + _meta wrapping pattern.
 */
function buildResponse(
  content: CallToolResult["content"],
  options?: ResponseOptions & { isError?: boolean },
): CallToolResult {
  return {
    content,
    ...(options?.isError && { isError: true }),
    ...(options?._meta && { _meta: options._meta }),
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
  options?: { _meta?: Record<string, unknown> },
): CallToolResult {
  if (items.length === 0) {
    throw new TypeError("multi() requires at least one content item");
  }
  return buildResponse(
    items.map((item) => withAnnotations({ ...item }, item.annotations)),
    options,
  );
}
