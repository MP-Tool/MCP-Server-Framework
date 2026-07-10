/**
 * Icon Loading Helper
 *
 * Reusable primitive for framework consumers who want to ship an MCP-spec
 * `Icon` (part of the `Implementation` object returned during `initialize`)
 * without hand-managing base64 encoding themselves.
 *
 * @module utils/icon
 */

import { readFileSync } from "node:fs";
import type { Icon } from "@modelcontextprotocol/sdk/types.js";
import { ConfigurationError } from "../errors/categories/validation.js";

/**
 * Maximum icon file size accepted by {@link iconFromFile}.
 *
 * The encoded icon is embedded (base64, +33% size) in every `initialize`
 * response, so an oversized file would bloat every session handshake.
 * Typical favicons are well under 100 KB; 1 MB leaves generous headroom.
 */
const MAX_ICON_FILE_BYTES = 1024 * 1024;

/**
 * Builds an MCP `Icon` from a local image file by reading it synchronously
 * and embedding it as a base64 `data:` URI.
 *
 * A `data:` URI works identically across stdio and HTTP transports since the
 * icon travels inline in the JSON-RPC `initialize` response — no separate
 * asset serving is required.
 *
 * Intended for startup-time use (e.g. module-level `const` initialization),
 * mirroring the framework's existing synchronous-read-at-startup pattern
 * used for config files and TLS certificates.
 *
 * @param filePath - Absolute path to the icon file
 * @param mimeType - MIME type of the icon, e.g. `'image/svg+xml'`, `'image/png'`
 * @param options - Optional `sizes`/`theme` metadata per the MCP `Icon` schema
 * @throws {ConfigurationError} If the file cannot be read or exceeds 1 MB
 */
export function iconFromFile(
  filePath: string,
  mimeType: string,
  options?: { sizes?: string[]; theme?: "light" | "dark" },
): Icon {
  let bytes: Buffer;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is supplied by the consumer at startup, not user input
    bytes = readFileSync(filePath);
  } catch (cause) {
    throw new ConfigurationError(`Failed to read icon file: ${filePath}`, {
      cause: cause instanceof Error ? cause : undefined,
      recoveryHint: `Check that '${filePath}' exists and is readable.`,
    });
  }

  if (bytes.byteLength > MAX_ICON_FILE_BYTES) {
    throw new ConfigurationError(
      `Icon file exceeds ${String(MAX_ICON_FILE_BYTES)} bytes (${String(bytes.byteLength)}): ${filePath}`,
      {
        recoveryHint: `Use an icon of at most 1 MB — it is embedded in every MCP initialize response.`,
      },
    );
  }

  return {
    src: `data:${mimeType};base64,${bytes.toString("base64")}`,
    mimeType,
    ...options,
  };
}
