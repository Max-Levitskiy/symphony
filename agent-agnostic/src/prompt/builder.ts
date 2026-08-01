/**
 * Prompt construction (spec section 12, plus the capability-aware continuation rule from 7.1).
 *
 * The interesting decision lives here: whether a continuation turn resends the whole task prompt.
 * That follows the adapter's `session_continuation` capability, never the adapter's name.
 */

import { toSymphonyError, type Result, err, ok } from "../errors.ts";
import type { Issue } from "../types.ts";
import { renderTemplate } from "./template.ts";

export const DEFAULT_PROMPT = "You are working on an issue from the configured tracker.";

export type TurnPromptInput = {
  template: string;
  issue: Issue;
  /** 1-based retry/continuation counter; null on the first attempt (spec 12.3). */
  attempt: number | null;
  turn_number: number;
  max_turns: number;
  /**
   * True on turn 1, and on every turn when the adapter cannot carry conversation state
   * (spec 7.1 as rewritten by delta D-008).
   */
  full_prompt: boolean;
};

const CONTINUATION_GUIDANCE = [
  "Continue the work you were doing on this issue.",
  "",
  "- The issue is still in an active state, so it is not finished.",
  "- Resume from the current workspace state; do not restart from scratch.",
  "- Do not repeat investigation or validation you have already completed.",
  "- Stop only when the work is handed off according to the workflow, or you hit a true external",
  "  blocker such as missing access, tools, or credentials.",
].join("\n");

export function buildTurnPrompt(input: TurnPromptInput): Result<string> {
  const template = input.template.trim().length > 0 ? input.template : DEFAULT_PROMPT;

  if (!input.full_prompt) {
    // The agent already holds the task prompt in its own session history. Resending it wastes
    // context and invites the agent to restart work it has already done.
    return ok(
      `${CONTINUATION_GUIDANCE}\n\nThis is turn ${input.turn_number} of at most ${input.max_turns}.`,
    );
  }

  let rendered: string;
  try {
    rendered = renderTemplate(template, {
      issue: input.issue as unknown as Record<string, unknown>,
      attempt: input.attempt,
    });
  } catch (error) {
    const symphonyError = toSymphonyError("template_render_error", error);
    return err(symphonyError.category, symphonyError.message);
  }

  if (input.turn_number === 1) return ok(rendered);

  // Stateless adapter on a continuation turn: the full task plus what to do with it.
  return ok(
    `${rendered}\n\n---\n\n${CONTINUATION_GUIDANCE}\n\nThis is turn ${input.turn_number} of at most ${input.max_turns}.`,
  );
}
