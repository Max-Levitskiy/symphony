/**
 * Core domain model (spec section 4).
 *
 * These types are shared by the orchestrator, both adapter families, and observability. Nothing
 * here may reference a specific coding agent or a specific issue tracker.
 */

export type BlockerRef = {
  id: string | null;
  identifier: string | null;
  state: string | null;
};

/** Normalized schedulable work item (spec 4.1.1). */
export type Issue = {
  id: string;
  native_ref: Record<string, unknown> | null;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branch_name: string | null;
  url: string | null;
  assignee_id: string | null;
  labels: string[];
  blocked_by: BlockerRef[];
  dispatchable: boolean;
  created_at: string | null;
  updated_at: string | null;
};

/** Parsed WORKFLOW.md payload (spec 4.1.2). */
export type WorkflowDefinition = {
  config: Record<string, unknown>;
  prompt_template: string;
};

/** Workspace assigned to one issue identifier (spec 4.1.4). */
export type Workspace = {
  path: string;
  workspace_key: string;
  created_now: boolean;
};

/** Live agent session metadata (spec 4.1.6, as rewritten by delta D-004). */
export type LiveSession = {
  agent_kind: string;
  session_id: string | null;
  session_key: string | null;
  turn_key: string | null;
  agent_process_pid: string | null;
  last_agent_event: string | null;
  last_agent_timestamp: string | null;
  last_agent_message: string | null;
  agent_input_tokens: number;
  agent_output_tokens: number;
  agent_total_tokens: number;
  last_reported_input_tokens: number;
  last_reported_output_tokens: number;
  last_reported_total_tokens: number;
  usage_reported: boolean;
  turn_count: number;
};

export function emptyLiveSession(agentKind: string): LiveSession {
  return {
    agent_kind: agentKind,
    session_id: null,
    session_key: null,
    turn_key: null,
    agent_process_pid: null,
    last_agent_event: null,
    last_agent_timestamp: null,
    last_agent_message: null,
    agent_input_tokens: 0,
    agent_output_tokens: 0,
    agent_total_tokens: 0,
    last_reported_input_tokens: 0,
    last_reported_output_tokens: 0,
    last_reported_total_tokens: 0,
    usage_reported: false,
    turn_count: 0,
  };
}

/** Scheduled retry state for an issue (spec 4.1.7). */
export type RetryEntry = {
  issue_id: string;
  identifier: string;
  attempt: number;
  due_at_ms: number;
  timer_handle: ReturnType<typeof setTimeout> | null;
  error: string | null;
};

export type AgentTotals = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  seconds_running: number;
};

/** Normalize a state name for scheduler comparison (spec 4.2). */
export const normalizeState = (state: string): string => state.trim().toLowerCase();

/** Normalize a label for comparison (spec 11.3). */
export const normalizeLabel = (label: string): string => label.trim().toLowerCase();
