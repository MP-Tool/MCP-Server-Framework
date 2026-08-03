/**
 * User confirmation via MCP Elicitation.
 *
 * `elicitConfirmation()` asks the human operator to approve an action before the
 * server executes it, using the client's elicitation UI (`elicitation/create`).
 * The prompt has no form fields — the client's accept/decline/cancel action is the
 * answer, so the user confirms with a single click (the "accept" action approves).
 *
 * The helper never throws: every failure mode maps to an explicit outcome so
 * callers can implement their own policy (e.g. fail-closed vs. fail-open when
 * the client cannot prompt the user at all).
 *
 * @module mcp/elicit-confirmation
 */

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "../logger/index.js";
import { getCurrentToolContext } from "./current-tool-context.js";
import type { ToolContext } from "./types/context.js";

/**
 * Outcome of a confirmation prompt.
 *
 * - `"accepted"` — the user approved (the "accept" action)
 * - `"declined"` — the user rejected the prompt
 * - `"cancelled"` — the user dismissed the prompt without answering
 * - `"timeout"` — the prompt expired unanswered (request timeout, see `timeoutMs`)
 * - `"unsupported"` — the client cannot prompt at all (no elicitation capability,
 *   stateless mode, or the client rejected the elicitation request itself)
 */
export type ElicitConfirmationOutcome = "accepted" | "declined" | "cancelled" | "timeout" | "unsupported";

/** Default confirmation timeout — humans need longer than the SDK's 60s request default. */
export const DEFAULT_CONFIRMATION_TIMEOUT_MS = 300_000;

/** Options for {@link elicitConfirmation}. */
export interface ElicitConfirmationOptions {
  /** Human-readable prompt shown to the user (state WHAT will happen and to WHICH resource). */
  message: string;
  /**
   * How long to wait for the user to answer, in milliseconds, before returning
   * `"timeout"`. Defaults to {@link DEFAULT_CONFIRMATION_TIMEOUT_MS} (5 minutes).
   */
  timeoutMs?: number | undefined;
  /**
   * Tool context override. Defaults to the ambient context of the currently
   * executing tool call (AsyncLocalStorage). Pass explicitly in tests or when
   * calling outside a tool handler.
   */
  context?: Pick<ToolContext, "elicitInput"> | undefined;
}

/**
 * Asks the user to confirm an action via the client's elicitation UI.
 *
 * Returns `"accepted"` when the user chose the "accept" action. All error paths are
 * folded into the returned outcome — this function does not throw.
 *
 * @example
 * ```typescript
 * const outcome = await elicitConfirmation({
 *   message: 'Delete stack "web-prod"? This action may not be reversible.',
 * });
 * if (outcome !== "accepted") throw new Error(`Confirmation ${outcome}`);
 * ```
 */
export async function elicitConfirmation(options: ElicitConfirmationOptions): Promise<ElicitConfirmationOutcome> {
  const ctx = options.context ?? getCurrentToolContext();
  const elicitInput = ctx?.elicitInput;
  if (!elicitInput) return "unsupported";

  const timeout = options.timeoutMs ?? DEFAULT_CONFIRMATION_TIMEOUT_MS;

  let result;
  try {
    result = await elicitInput(
      {
        message: options.message,
        // No form fields — the accept/decline/cancel action IS the answer.
        requestedSchema: { type: "object", properties: {} },
      },
      { timeout },
    );
  } catch (err) {
    // @sdk-constraint — McpError.code is a plain number, ErrorCode a TS enum
    // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
    if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) {
      return "timeout";
    }
    // Covers clients that advertise `elicitation` without the `form` sub-capability
    // (the SDK throws before sending) as well as client-side elicitation errors.
    logger.debug("elicitConfirmation failed, treating as unsupported: %s", String(err));
    return "unsupported";
  }

  if (!result) return "unsupported";
  switch (result.action) {
    case "accept":
      return "accepted";
    case "decline":
      return "declined";
    case "cancel":
      return "cancelled";
  }
}
