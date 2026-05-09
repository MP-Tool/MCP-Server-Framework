/**
 * Response Types
 *
 * Types for response helper functions used in tool handlers.
 * Provides a type-safe API for creating MCP tool responses.
 *
 * @module mcp/types/response
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// ============================================================================
// Content Types
// ============================================================================

/**
 * Audience for content annotations.
 */
export type ContentAudience = "user" | "assistant";

/**
 * Annotations that can be attached to content.
 */
export interface ContentAnnotations {
  /** Target audience for this content */
  readonly audience?: ContentAudience[];
  /** Priority of this content (higher = more important) */
  readonly priority?: number;
  /** ISO 8601 timestamp of last modification */
  readonly lastModified?: string;
}

/**
 * Reference to a server-exposed resource appended to a tool response.
 *
 * Tool helpers (`text()`, `json()`, `structured()`) accept a `links` option
 * that emits one `resource_link` content block per entry. Clients can then
 * call `resources/read` with the URI to retrieve the full payload without
 * inlining it in the tool result.
 */
export interface ResourceLinkSpec {
  /** Resource URI (must be readable via `resources/read`) */
  readonly uri: string;
  /** Human-readable resource name */
  readonly name: string;
  /** Optional MIME type of the linked resource */
  readonly mimeType?: string;
  /** Optional short description */
  readonly description?: string;
  /** Optional title (display label preferred by clients) */
  readonly title?: string;
  /** Optional content annotations */
  readonly annotations?: ContentAnnotations;
}

// ============================================================================
// Response Options
// ============================================================================

/**
 * Base options for response helpers.
 */
export interface ResponseOptions {
  /** Annotations to attach to the content */
  readonly annotations?: ContentAnnotations;
  /** Custom metadata */
  readonly _meta?: Record<string, unknown>;
  /**
   * Structured payload that mirrors the tool's `outputSchema`.
   *
   * When set, the framework forwards it on the `CallToolResult` as
   * `structuredContent`. Clients use it for typed access to the tool's
   * result while the human-readable `content` array stays unchanged.
   */
  readonly structuredContent?: Record<string, unknown>;
  /**
   * Resource references to append to the response as `resource_link`
   * content blocks. One block is appended per entry, in the given order,
   * after the primary content. Useful for pointing at large payloads
   * stored as readable resources without inlining them.
   */
  readonly links?: readonly ResourceLinkSpec[];
}

/**
 * Options for text responses.
 */
export interface TextResponseOptions extends ResponseOptions {
  // Text-specific options can be added here
}

/**
 * Options for JSON responses.
 */
export interface JsonResponseOptions extends ResponseOptions {
  /** Number of spaces for indentation (default: 2, use 0 for compact) */
  readonly indent?: number;
}

/**
 * Options for structured responses (`structured()` helper).
 *
 * In addition to the base response options, callers may provide a custom
 * `text` representation that replaces the default JSON serialization in the
 * `TextContent` block. This lets typed tools render a human-readable view
 * (e.g. Markdown) for client UIs while keeping `structuredContent` as the
 * single source of truth for the LLM and programmatic consumers.
 */
export interface StructuredResponseOptions extends ResponseOptions {
  /**
   * Custom text representation for the `TextContent` block.
   *
   * When set, the framework uses this string verbatim instead of serializing
   * `data` to JSON. Modern clients still consume `structuredContent`; legacy
   * clients and human readers see this rendering. Recommended for
   * Markdown summaries, ASCII tables, or other display-oriented formats.
   */
  readonly text?: string;
  /**
   * Number of spaces for JSON indentation when no `text` override is given
   * (default: 2, use 0 for compact).
   */
  readonly indent?: number;
}

/**
 * Options for error responses.
 */
export interface ErrorResponseOptions extends ResponseOptions {
  // Error-specific options can be added here
}

// ============================================================================
// Media Types
// ============================================================================

/**
 * Supported image MIME types.
 */
export type ImageMimeType = "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/svg+xml";

/**
 * Options for image responses.
 */
export interface ImageResponseOptions extends ResponseOptions {
  /** MIME type of the image (default: 'image/png') */
  readonly mimeType?: ImageMimeType;
}

/**
 * Supported audio MIME types.
 */
export type AudioMimeType = "audio/wav" | "audio/mp3" | "audio/mpeg" | "audio/ogg" | "audio/webm";

/**
 * Options for audio responses.
 */
export interface AudioResponseOptions extends ResponseOptions {
  /** MIME type of the audio (default: 'audio/wav') */
  readonly mimeType?: AudioMimeType;
}

// ============================================================================
// Response Type Alias
// ============================================================================

/**
 * Tool response type - alias for CallToolResult.
 *
 * This is the return type for all response helpers.
 */
export type ToolResponse = CallToolResult;
