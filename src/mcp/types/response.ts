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
