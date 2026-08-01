/**
 * Agent adapter contract (spec section 10 as rewritten by delta D-011).
 *
 * The one rule this file exists to enforce: nothing outside `src/agent/<adapter>.ts` may know
 * which coding agent is running. The orchestrator sees capabilities, normalized events, and a
 * turn outcome — never a vendor protocol.
 */

import type { Result } from "../errors.ts";
import type { Logger } from "../logging.ts";
import type { RunnerConfig } from "../config/schema.ts";
import type { Issue } from "../types.ts";

/** Spec 10.3. Every key is REQUIRED; there is no default, because a default hides a lie. */
export type AgentCapabilities = {
  session_continuation: boolean;
  streaming_events: boolean;
  client_tools: boolean;
  approvals: boolean;
  cancellation: boolean;
  usage_reporting: boolean;
  rate_limit_reporting: boolean;
};

export const CAPABILITY_KEYS = [
  "session_continuation",
  "streaming_events",
  "client_tools",
  "approvals",
  "cancellation",
  "usage_reporting",
  "rate_limit_reporting",
] as const satisfies readonly (keyof AgentCapabilities)[];

/** Spec 10.6. Orchestrator logic may depend on nothing outside this list. */
export const AGENT_EVENT_NAMES = [
  "session_started",
  "startup_failed",
  "turn_started",
  "turn_completed",
  "turn_failed",
  "turn_cancelled",
  "turn_timed_out",
  "turn_input_required",
  "approval_requested",
  "approval_resolved",
  "tool_call_completed",
  "tool_call_failed",
  "unsupported_tool_call",
  "client_tools_unavailable",
  "usage_updated",
  "rate_limits_updated",
  "notification",
  "other_message",
  "malformed",
] as const;

export type AgentEventName = (typeof AGENT_EVENT_NAMES)[number];

export type UsageReport = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  /** `cumulative` = absolute session totals; `incremental` = delta since the last report. */
  mode: "cumulative" | "incremental";
};

export type AgentEvent = {
  event: AgentEventName;
  timestamp: string;
  agent_kind: string;
  agent_process_pid?: string | null;
  usage?: UsageReport;
  rate_limits?: unknown;
  message?: string;
  /** Raw payload, truncated. Debugging only — orchestrator logic must not read it. */
  native?: unknown;
};

export type TurnStatus = "completed" | "failed" | "cancelled" | "timed_out" | "input_required";

export type TurnInput = {
  turn_number: number;
  kind: "initial" | "continuation";
  text: string;
  title?: string;
};

export type TurnOutcome = {
  status: TurnStatus;
  turn_key: string;
  error_category?: string | null;
  message?: string | null;
};

export type ToolSpec = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type ToolResult = {
  success: boolean;
  /** JSON-safe structured output the adapter translates into its runtime's tool-result shape. */
  output?: unknown;
  error?: string;
};

export type StartSessionParams = {
  workspace_path: string;
  issue: Issue;
  runner: RunnerConfig;
  tools: ToolSpec[];
  execute_tool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  on_event: (event: AgentEvent) => void;
  environment: Record<string, string>;
  logger: Logger;
};

export interface AgentSession {
  readonly session_key: string;
  readonly agent_process_pid: string | null;
  readonly capabilities: AgentCapabilities;
  runTurn(input: TurnInput): Promise<Result<TurnOutcome>>;
  stop(): Promise<void>;
}

export interface AgentAdapter {
  /** The `runner.kind` value this adapter answers to. */
  readonly kind: string;
  capabilities(runner?: RunnerConfig): AgentCapabilities;
  validateConfig(runner: RunnerConfig): Result<void>;
  /** Environment variable names whose *values* must be redacted from logs and snapshots. */
  sensitiveEnvironmentNames(runner: RunnerConfig): string[];
  startSession(params: StartSessionParams): Promise<Result<AgentSession>>;
}

/** Convenience for adapters: build a normalized event with the boilerplate filled in. */
export function agentEvent(
  kind: string,
  event: AgentEventName,
  extra: Partial<Omit<AgentEvent, "event" | "agent_kind" | "timestamp">> = {},
): AgentEvent {
  return { event, agent_kind: kind, timestamp: new Date().toISOString(), ...extra };
}

/** Truncate a native payload before it reaches a log line (spec 13.1). */
export function truncateNative(value: unknown, limit = 2000): unknown {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return text.length <= limit ? value : `${text.slice(0, limit)}…[truncated ${text.length - limit}]`;
}
