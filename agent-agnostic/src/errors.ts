/**
 * Portable error categories and the Result type used across adapter boundaries.
 *
 * Spec: sections 5.5, 10.8, 11.4. The orchestrator relies only on success versus failure; the
 * category exists for logs, retry labels, and operator messages.
 */

export type ErrorCategory =
  // Workflow and config (spec 5.5, 6.3)
  | "missing_workflow_file"
  | "workflow_parse_error"
  | "workflow_front_matter_not_a_map"
  | "template_parse_error"
  | "template_render_error"
  | "invalid_config"
  // Agent runtime (spec 10.8)
  | "unsupported_agent_kind"
  | "invalid_runner_config"
  | "missing_agent_secret"
  | "agent_runtime_not_found"
  | "agent_capability_unsupported"
  | "invalid_workspace_cwd"
  | "response_timeout"
  | "turn_timeout"
  | "agent_exit"
  | "response_error"
  | "turn_failed"
  | "turn_cancelled"
  | "turn_input_required"
  // Tracker (spec 11.4)
  | "unsupported_tracker_kind"
  | "invalid_tracker_config"
  | "missing_tracker_secret"
  | "tracker_request"
  | "tracker_status"
  | "tracker_response"
  | "tracker_pagination"
  | "tracker_rate_limited"
  // Workspace (spec 14.1)
  | "workspace_error"
  | "hook_failed"
  | "hook_timeout";

export class SymphonyError extends Error {
  constructor(
    readonly category: ErrorCategory,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "SymphonyError";
  }

  toJSON() {
    return { category: this.category, message: this.message };
  }
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: SymphonyError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

export const err = <T = never>(
  category: ErrorCategory,
  message: string,
  detail?: unknown,
): Result<T> => ({ ok: false, error: new SymphonyError(category, message, detail) });

/** Wrap an unknown thrown value into a categorized error. */
export function toSymphonyError(category: ErrorCategory, error: unknown): SymphonyError {
  if (error instanceof SymphonyError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new SymphonyError(category, message);
}
