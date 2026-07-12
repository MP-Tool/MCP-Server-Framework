/**
 * User confirmation via MCP Elicitation.
 *
 * `elicitConfirmation()` asks the human operator to approve an action before the
 * server executes it, using the client's elicitation UI (`elicitation/create`).
 * The prompt is a form with a single required `confirm` checkbox — approval needs
 * both the "accept" action AND a ticked checkbox (double opt-in), so a hasty
 * "accept" with defaults does not authorize anything.
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
 * - `"accepted"` — the user explicitly approved (accept action + confirm checkbox ticked)
 * - `"declined"` — the user rejected, or accepted without ticking the checkbox
 * - `"cancelled"` — the user dismissed the prompt without answering
 * - `"timeout"` — the prompt expired unanswered (SDK request timeout, default 60s)
 * - `"unsupported"` — the client cannot prompt at all (no elicitation capability,
 *   stateless mode, or the client rejected the elicitation request itself)
 */
export type ElicitConfirmationOutcome = "accepted" | "declined" | "cancelled" | "timeout" | "unsupported";

/** Options for {@link elicitConfirmation}. */
export interface ElicitConfirmationOptions {
  /** Human-readable prompt shown to the user (state WHAT will happen and to WHICH resource). */
  message: string;
  /** Title of the confirm checkbox (default: "Confirm"). */
  confirmTitle?: string | undefined;
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
 * Returns `"accepted"` only when the user chose "accept" AND ticked the confirm
 * checkbox. All error paths are folded into the returned outcome — this function
 * does not throw.
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

  let result;
  try {
    result = await elicitInput({
      message: options.message,
      requestedSchema: {
        type: "object",
        properties: {
          confirm: {
            type: "boolean",
            title: options.confirmTitle ?? "Confirm",
            description: "Tick to confirm this action",
            default: false,
          },
        },
        required: ["confirm"],
      },
    });
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
      return result.content?.["confirm"] === true ? "accepted" : "declined";
    case "decline":
      return "declined";
    case "cancel":
      return "cancelled";
  }
}
