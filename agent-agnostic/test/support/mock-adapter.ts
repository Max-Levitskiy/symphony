/**
 * Parameterizable agent adapter test double.
 *
 * Forked spec 17.5 makes the capability fallbacks the tests that matter most, and the only way to
 * test them all is an adapter whose capability set is an input. This double also records the exact
 * prompt text of every turn, which is how the continuation-prompt rules are verified.
 */

import { err, ok, type Result } from "../../src/errors.ts";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentEvent,
  AgentSession,
  StartSessionParams,
  TurnInput,
  TurnOutcome,
  TurnStatus,
} from "../../src/agent/types.ts";
import { agentEvent } from "../../src/agent/types.ts";

export type MockScript = {
  kind?: string;
  capabilities?: Partial<AgentCapabilities>;
  /** Status per turn, 1-based. Missing entries default to `completed`. */
  statuses?: TurnStatus[];
  /** Usage reported after each turn. */
  usage?: { input: number; output: number; total: number; mode: "cumulative" | "incremental" }[];
  /** Milliseconds to wait inside runTurn, for stall and cancellation tests. */
  turnDelayMs?: number;
  startupError?: string;
};

export type MockRecord = {
  sessions: number;
  turns: { turn_number: number; kind: TurnInput["kind"]; text: string; title?: string }[];
  toolsAdvertised: string[][];
  environments: Record<string, string>[];
  workspaces: string[];
  stopped: number;
  events: AgentEvent[];
};

const FULL: AgentCapabilities = {
  session_continuation: true,
  streaming_events: true,
  client_tools: true,
  approvals: true,
  cancellation: true,
  usage_reporting: true,
  rate_limit_reporting: true,
};

export function mockAdapter(script: MockScript = {}): { adapter: AgentAdapter; record: MockRecord } {
  const kind = script.kind ?? "mock";
  const capabilities: AgentCapabilities = { ...FULL, ...script.capabilities };
  const record: MockRecord = {
    sessions: 0,
    turns: [],
    toolsAdvertised: [],
    environments: [],
    workspaces: [],
    stopped: 0,
    events: [],
  };

  const adapter: AgentAdapter = {
    kind,
    capabilities: () => ({ ...capabilities }),
    validateConfig: () => ok(undefined),
    sensitiveEnvironmentNames: (runner) => Object.keys(runner.env),
    async startSession(params: StartSessionParams): Promise<Result<AgentSession>> {
      const emit = (event: AgentEvent) => {
        record.events.push(event);
        params.on_event(event);
      };

      if (script.startupError) {
        emit(agentEvent(kind, "startup_failed", { message: script.startupError }));
        return err("response_error", script.startupError);
      }

      record.sessions += 1;
      record.toolsAdvertised.push(params.tools.map((t) => t.name));
      record.environments.push(params.environment);
      record.workspaces.push(params.workspace_path);

      if (!capabilities.client_tools && params.tools.length > 0) {
        emit(agentEvent(kind, "client_tools_unavailable", { message: `${params.tools.length} tool(s)` }));
      }
      const sessionKey = `${kind}-session-${record.sessions}`;
      emit(agentEvent(kind, "session_started", { message: sessionKey }));

      let stopped = false;
      let cancelTurn: (() => void) | null = null;
      const session: AgentSession = {
        session_key: sessionKey,
        agent_process_pid: null,
        capabilities: { ...capabilities },
        async runTurn(input: TurnInput): Promise<Result<TurnOutcome>> {
          record.turns.push({
            turn_number: input.turn_number,
            kind: input.kind,
            text: input.text,
            title: input.title,
          });
          if (capabilities.streaming_events) {
            emit(agentEvent(kind, "turn_started", { message: `turn-${input.turn_number}` }));
          }
          if (script.turnDelayMs) {
            // Cancellable, like a real adapter whose stop() terminates an in-flight turn.
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, script.turnDelayMs);
              cancelTurn = () => {
                clearTimeout(timer);
                resolve();
              };
            });
            cancelTurn = null;
          }
          if (stopped) {
            return ok({ status: "cancelled", turn_key: `turn-${input.turn_number}`, error_category: "turn_cancelled" });
          }

          const usage = script.usage?.[input.turn_number - 1];
          if (usage && capabilities.usage_reporting) {
            emit(
              agentEvent(kind, "usage_updated", {
                usage: {
                  input_tokens: usage.input,
                  output_tokens: usage.output,
                  total_tokens: usage.total,
                  mode: usage.mode,
                },
              }),
            );
          }

          const status = script.statuses?.[input.turn_number - 1] ?? "completed";
          emit(
            agentEvent(
              kind,
              status === "completed"
                ? "turn_completed"
                : status === "cancelled"
                  ? "turn_cancelled"
                  : status === "timed_out"
                    ? "turn_timed_out"
                    : status === "input_required"
                      ? "turn_input_required"
                      : "turn_failed",
              { message: `turn-${input.turn_number}` },
            ),
          );
          return ok({
            status,
            turn_key: `turn-${input.turn_number}`,
            error_category: status === "completed" ? null : status,
            message: status === "completed" ? null : `mock turn ${status}`,
          });
        },
        async stop() {
          stopped = true;
          record.stopped += 1;
          cancelTurn?.();
        },
      };
      return ok(session);
    },
  };

  return { adapter, record };
}
