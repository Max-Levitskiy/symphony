/**
 * `claude-code` adapter — forked spec Appendix B.2.
 *
 * Drives the Claude Code CLI in headless streaming mode: newline-delimited JSON in, newline-delimited
 * JSON out, one turn per user message, terminated by the runtime's `result` message.
 *
 * Two capabilities are `false` and the reasons are worth stating, because a `false` capability is a
 * claim about the runtime, not an excuse:
 *
 * - `approvals`: the CLI is launched in a non-blocking permission mode, so approval requests cannot
 *   arrive. Access control is expressed with tool allow/deny lists and external sandboxing.
 * - `client_tools`: the CLI reaches host tools through MCP servers rather than an inline tool
 *   protocol. Until this adapter hosts an MCP bridge it cannot honor `client_tools=true`, so it
 *   declares `false` and the orchestrator takes the documented fallback. Point `mcp_config` at a
 *   tracker MCP server to give the agent tracker writes another way.
 */

import { err, ok, toSymphonyError, type Result } from "../errors.ts";
import type { RunnerConfig } from "../config/schema.ts";
import {
  agentEvent,
  truncateNative,
  type AgentAdapter,
  type AgentCapabilities,
  type AgentSession,
  type StartSessionParams,
  type TurnInput,
  type TurnOutcome,
} from "./types.ts";
import { briefly, deferred, spawnAgentProcess, type SpawnedAgent } from "./process.ts";

const KIND = "claude-code";
const DEFAULT_COMMAND = "claude -p --output-format stream-json --input-format stream-json --verbose";

const CAPABILITIES: AgentCapabilities = {
  session_continuation: true,
  streaming_events: true,
  client_tools: false,
  approvals: false,
  cancellation: true,
  usage_reporting: true,
  rate_limit_reporting: false,
};

function buildCommand(runner: RunnerConfig): string {
  if (runner.command) return runner.command;
  const provider = runner.provider;
  const parts = [DEFAULT_COMMAND];
  const flag = (name: string, value: unknown) => {
    if (typeof value === "string" && value.trim().length > 0) parts.push(`${name} ${JSON.stringify(value)}`);
  };
  flag("--model", provider.model);
  flag("--permission-mode", provider.permission_mode ?? "bypassPermissions");
  flag("--mcp-config", provider.mcp_config);
  for (const [name, key] of [
    ["--allowed-tools", "allowed_tools"],
    ["--disallowed-tools", "disallowed_tools"],
  ] as const) {
    const value = provider[key];
    if (Array.isArray(value) && value.length > 0) parts.push(`${name} ${JSON.stringify(value.join(","))}`);
    else if (typeof value === "string" && value.length > 0) parts.push(`${name} ${JSON.stringify(value)}`);
  }
  if (typeof provider.extra_args === "string" && provider.extra_args.trim().length > 0) {
    parts.push(provider.extra_args);
  }
  return parts.join(" ");
}

type Message = Record<string, unknown>;

function extractUsage(message: Message): { input: number; output: number; total: number } | null {
  const usage = (message.usage ?? (message.message as Message | undefined)?.usage) as Message | undefined;
  if (!usage) return null;
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const input =
    num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens);
  const output = num(usage.output_tokens);
  if (input === 0 && output === 0) return null;
  return { input, output, total: input + output };
}

class ClaudeCodeSession implements AgentSession {
  readonly capabilities = CAPABILITIES;
  #sessionKey: string;
  #turn: { resolve: (outcome: TurnOutcome) => void; turnKey: string; reset: () => void } | null = null;
  #stopped = false;
  #pumpDone: Promise<void> = Promise.resolve();
  #cumulative = { input: 0, output: 0, total: 0 };

  constructor(
    readonly agent_process_pid: string | null,
    private readonly agent: SpawnedAgent,
    private readonly params: StartSessionParams,
  ) {
    this.#sessionKey = `claude-${crypto.randomUUID()}`;
  }

  get session_key(): string {
    return this.#sessionKey;
  }

  static async open(params: StartSessionParams): Promise<Result<AgentSession>> {
    const agent = spawnAgentProcess({
      command: buildCommand(params.runner),
      cwd: params.workspace_path,
      env: params.environment,
      logger: params.logger,
    });
    const session = new ClaudeCodeSession(agent.pid, agent, params);
    session.#pumpDone = session.#pump();

    if (params.tools.length > 0) {
      // Documented fallback for `client_tools=false` (spec 10.3): say so once, then continue.
      params.on_event(
        agentEvent(KIND, "client_tools_unavailable", {
          agent_process_pid: agent.pid,
          message: `${params.tools.length} tracker tool(s) not advertised; configure an MCP server via runner.provider.mcp_config`,
        }),
      );
    }
    params.on_event(
      agentEvent(KIND, "session_started", {
        agent_process_pid: agent.pid,
        message: session.session_key,
      }),
    );
    return ok(session);
  }

  async #pump(): Promise<void> {
    try {
      for await (const line of this.agent.lines) {
        if (line.trim().length === 0) continue;
        let message: Message;
        try {
          message = JSON.parse(line) as Message;
        } catch {
          this.params.on_event(
            agentEvent(KIND, "malformed", { agent_process_pid: this.agent.pid, message: briefly(line) }),
          );
          continue;
        }
        this.#handle(message);
      }
    } catch (error) {
      this.params.logger.debug("claude stream ended", {
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (this.#turn && !this.#stopped) {
        this.#finish({
          status: "failed",
          turn_key: this.#turn.turnKey,
          error_category: "agent_exit",
          message: "claude process exited mid-turn",
        });
      }
    }
  }

  #finish(outcome: TurnOutcome): void {
    const turn = this.#turn;
    this.#turn = null;
    turn?.resolve(outcome);
  }

  #handle(message: Message): void {
    this.#turn?.reset();

    // The CLI's own session id is the better correlation key when it appears.
    const claudeSessionId = message.session_id;
    if (typeof claudeSessionId === "string" && claudeSessionId.length > 0) {
      this.#sessionKey = claudeSessionId;
    }

    const usage = extractUsage(message);
    if (usage && (usage.total > this.#cumulative.total || message.type === "result")) {
      this.#cumulative = usage;
      this.params.on_event(
        agentEvent(KIND, "usage_updated", {
          agent_process_pid: this.agent.pid,
          usage: {
            input_tokens: usage.input,
            output_tokens: usage.output,
            total_tokens: usage.total,
            mode: "cumulative",
          },
        }),
      );
    }

    if (message.type === "result") {
      const failed = message.is_error === true || String(message.subtype ?? "").startsWith("error");
      this.params.on_event(
        agentEvent(KIND, failed ? "turn_failed" : "turn_completed", {
          agent_process_pid: this.agent.pid,
          native: truncateNative(message),
          message: briefly(message.result ?? message.subtype ?? ""),
        }),
      );
      this.#finish({
        status: failed ? "failed" : "completed",
        turn_key: this.#turn?.turnKey ?? "unknown",
        error_category: failed ? "turn_failed" : null,
        message: failed ? briefly(message.result ?? message.subtype ?? "claude reported an error") : null,
      });
      return;
    }

    this.params.on_event(
      agentEvent(KIND, "notification", {
        agent_process_pid: this.agent.pid,
        message: String(message.type ?? "message"),
        native: truncateNative(message),
      }),
    );
  }

  async runTurn(input: TurnInput): Promise<Result<TurnOutcome>> {
    if (this.#stopped) return err("agent_exit", "session already stopped");

    const turnKey = `turn-${input.turn_number}`;
    const pending = deferred<TurnOutcome>();
    let silence: ReturnType<typeof setTimeout> | null = null;
    const reset = () => {
      if (silence) clearTimeout(silence);
      silence = setTimeout(() => {
        this.params.on_event(
          agentEvent(KIND, "turn_timed_out", {
            agent_process_pid: this.agent.pid,
            message: `no output for ${this.params.runner.turn_timeout_ms}ms`,
          }),
        );
        this.#finish({
          status: "timed_out",
          turn_key: turnKey,
          error_category: "turn_timeout",
          message: "turn stream went silent",
        });
      }, this.params.runner.turn_timeout_ms);
    };

    this.#turn = { resolve: pending.resolve, turnKey, reset };
    reset();

    try {
      this.agent.write(
        `${JSON.stringify({
          type: "user",
          message: { role: "user", content: [{ type: "text", text: input.text }] },
        })}\n`,
      );
      this.params.on_event(
        agentEvent(KIND, "turn_started", { agent_process_pid: this.agent.pid, message: turnKey }),
      );
    } catch (error) {
      if (silence) clearTimeout(silence);
      this.#turn = null;
      const symphony = toSymphonyError("agent_exit", error);
      return err(symphony.category, symphony.message);
    }

    const outcome = await pending.promise;
    if (silence) clearTimeout(silence);
    return ok(outcome);
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#finish({
      status: "cancelled",
      turn_key: "stopped",
      error_category: "turn_cancelled",
      message: "session stopped",
    });
    this.agent.kill();
    await Promise.race([this.agent.exited, Bun.sleep(2000)]);
    await Promise.race([this.#pumpDone, Bun.sleep(100)]);
  }
}

export const claudeCodeAdapter: AgentAdapter = {
  kind: KIND,
  capabilities: () => ({ ...CAPABILITIES }),
  validateConfig(runner: RunnerConfig) {
    if (buildCommand(runner).trim().length === 0) {
      return err("invalid_runner_config", "runner.command resolved to an empty command");
    }
    const provider = runner.provider;
    for (const key of ["model", "permission_mode", "mcp_config", "extra_args"] as const) {
      if (provider[key] !== undefined && typeof provider[key] !== "string") {
        return err("invalid_runner_config", `runner.provider.${key} must be a string`);
      }
    }
    return ok(undefined);
  },
  sensitiveEnvironmentNames(runner: RunnerConfig) {
    return [...new Set(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", ...Object.keys(runner.env)])];
  },
  startSession(params) {
    return ClaudeCodeSession.open(params);
  },
};
