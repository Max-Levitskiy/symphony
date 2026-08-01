/**
 * Issue tracker adapter contract (spec section 11) — unchanged in contract from upstream.
 *
 * A deliberately small read kernel plus OPTIONAL provider-native agent tools. Do not add generic
 * comment/state CRUD to make providers look alike; that loses provider semantics the orchestrator
 * never needed.
 */

import type { Result } from "../errors.ts";
import type { TrackerConfig } from "../config/schema.ts";
import type { Logger } from "../logging.ts";
import type { Issue } from "../types.ts";
import type { ToolResult, ToolSpec } from "../agent/types.ts";

export type TrackerContext = { issue: Issue };

export interface TrackerAdapter {
  readonly kind: string;
  /** Spec 11.1: candidate polling and startup terminal cleanup. */
  fetchIssuesByStates(states: string[]): Promise<Result<Issue[]>>;
  /** Spec 11.1: reconciliation and stale-dispatch revalidation. */
  fetchIssuesByIds(ids: string[]): Promise<Result<Issue[]>>;
  /** OPTIONAL provider-native agent tools (spec 10.7, 11.5). */
  agentToolSpecs?(): ToolSpec[];
  executeAgentTool?(
    name: string,
    args: Record<string, unknown>,
    context: TrackerContext,
  ): Promise<ToolResult>;
  /** Env var names to REMOVE from the agent child environment (spec 15.3). */
  secretEnvironmentNames?(): string[];
}

export type TrackerFactory = (options: {
  config: TrackerConfig;
  logger: Logger;
}) => Result<TrackerAdapter>;

/** Normalize an adapter's raw record into a valid Issue, or report why it is unusable (spec 11.3). */
export function normalizeIssue(raw: {
  id?: unknown;
  native_ref?: unknown;
  identifier?: unknown;
  title?: unknown;
  description?: unknown;
  priority?: unknown;
  state?: unknown;
  branch_name?: unknown;
  url?: unknown;
  assignee_id?: unknown;
  labels?: unknown;
  blocked_by?: unknown;
  dispatchable?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}): { ok: true; issue: Issue } | { ok: false; reason: string } {
  const requiredString = (value: unknown, name: string) => {
    if (typeof value !== "string" || value.trim().length === 0) {
      return `${name} must be a non-empty string`;
    }
    return null;
  };

  for (const [value, name] of [
    [raw.id, "id"],
    [raw.identifier, "identifier"],
    [raw.title, "title"],
    [raw.state, "state"],
  ] as const) {
    const problem = requiredString(value, name);
    if (problem) return { ok: false, reason: problem };
  }
  if (typeof raw.dispatchable !== "boolean") {
    return { ok: false, reason: "dispatchable must be an explicit boolean" };
  }

  const labels = Array.isArray(raw.labels)
    ? [
        ...new Set(
          raw.labels
            .filter((l): l is string => typeof l === "string")
            .map((l) => l.trim().toLowerCase())
            .filter((l) => l.length > 0),
        ),
      ]
    : [];

  const blocked = Array.isArray(raw.blocked_by)
    ? raw.blocked_by
        .filter((b): b is Record<string, unknown> => typeof b === "object" && b !== null)
        .map((b) => ({
          id: typeof b.id === "string" ? b.id : null,
          identifier: typeof b.identifier === "string" ? b.identifier : null,
          state: typeof b.state === "string" ? b.state : null,
        }))
    : [];

  const timestamp = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  };

  return {
    ok: true,
    issue: {
      id: (raw.id as string).trim(),
      native_ref:
        typeof raw.native_ref === "object" && raw.native_ref !== null && !Array.isArray(raw.native_ref)
          ? (raw.native_ref as Record<string, unknown>)
          : null,
      identifier: (raw.identifier as string).trim(),
      title: raw.title as string,
      description: typeof raw.description === "string" ? raw.description : null,
      priority:
        typeof raw.priority === "number" && Number.isInteger(raw.priority) ? raw.priority : null,
      state: raw.state as string,
      branch_name: typeof raw.branch_name === "string" ? raw.branch_name : null,
      url: typeof raw.url === "string" ? raw.url : null,
      assignee_id: typeof raw.assignee_id === "string" ? raw.assignee_id : null,
      labels,
      blocked_by: blocked,
      dispatchable: raw.dispatchable,
      created_at: timestamp(raw.created_at),
      updated_at: timestamp(raw.updated_at),
    },
  };
}
