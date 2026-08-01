/**
 * `codex-app-server` adapter — forked spec Appendix B.1.
 *
 * Reproduces upstream Symphony's behavior: a Codex CLI subprocess in app-server mode, speaking
 * newline-delimited JSON-RPC over stdio. Everything Codex-specific in this repository lives in
 * this file.
 *
 * Protocol note: the installed Codex version is the source of truth for schemas. Inspect it with
 * `codex app-server generate-json-schema --out <dir>`. The method names below target the v2
 * app-server surface (`initialize`, `thread/start`, `turn/start`).
 */

import { err, ok, SymphonyError, toSymphonyError, type Result } from "../errors.ts";
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
import { briefly, deferred, spawnAgentProcess, withTimeout, type SpawnedAgent } from "./process.ts";

const KIND = "codex-app-server";
const DEFAULT_COMMAND = "codex app-server";

const CAPABILITIES: AgentCapabilities = {
  session_continuation: true,
  streaming_events: true,
  client_tools: true,
  approvals: true,
  cancellation: true,
  usage_reporting: true,
  rate_limit_reporting: true,
};

type Message = Record<string, unknown>;

/** Requests the app-server sends us that expect a reply. */
const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);
const LEGACY_APPROVAL_METHODS = new Set(["execCommandApproval", "applyPatchApproval"]);

function extractUsage(payload: unknown): { input: number; output: number; total: number } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const source = payload as Record<string, unknown>;
  const read = (...names: string[]) => {
    for (const name of names) {
      const value = source[name];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
    return null;
  };
  const input = read("input_tokens", "inputTokens", "prompt_tokens");
  const output = read("output_tokens", "outputTokens", "completion_tokens");
  const total = read("total_tokens", "totalTokens");
  if (input === null && output === null && total === null) return null;
  return {
    input: input ?? 0,
    output: output ?? 0,
    total: total ?? (input ?? 0) + (output ?? 0),
  };
}

class CodexSession implements AgentSession {
  readonly capabilities = CAPABILITIES;
  #pending = new Map<number, { resolve: (v: Message) => void; reject: (e: unknown) => void }>();
  #nextId = 100;
  #turn: {
    resolve: (outcome: TurnOutcome) => void;
    turnKey: string | null;
    resetSilence: () => void;
  } | null = null;
  #stopped = false;
  #sessionKey = "";
  #pumpDone: Promise<void> = Promise.resolve();

  constructor(
    readonly agent_process_pid: string | null,
    private readonly agent: SpawnedAgent,
    private readonly params: StartSessionParams,
  ) {}

  get session_key(): string {
    return this.#sessionKey;
  }

  static async open(params: StartSessionParams): Promise<Result<CodexSession>> {
    const command = params.runner.command ?? DEFAULT_COMMAND;
    const agent = spawnAgentProcess({
      command,
      cwd: params.workspace_path,
      env: params.environment,
      logger: params.logger,
    });

    const session = new CodexSession(agent.pid, agent, params);
    session.#pumpDone = session.#pump();

    try {
      await withTimeout(
        session.#request("initialize", {
          capabilities: { experimentalApi: true },
          clientInfo: { name: "symphony-agent-agnostic", title: "Symphony", version: "0.1.0" },
        }),
        params.runner.read_timeout_ms,
        "response_timeout",
        "codex initialize timed out",
      );
      session.#notify("initialized", {});

      const provider = params.runner.provider;
      const threadParams: Message = {
        cwd: params.workspace_path,
        ...(provider.approval_policy !== undefined ? { approvalPolicy: provider.approval_policy } : {}),
        ...(provider.thread_sandbox !== undefined ? { sandbox: provider.thread_sandbox } : {}),
        ...(params.tools.length > 0
          ? {
              dynamicTools: params.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.input_schema,
              })),
            }
          : {}),
      };
      const threadResponse = await withTimeout(
        session.#request("thread/start", threadParams),
        params.runner.read_timeout_ms,
        "response_timeout",
        "codex thread/start timed out",
      );
      const thread = (threadResponse as { thread?: { id?: unknown } }).thread;
      if (!thread || typeof thread.id !== "string" || thread.id.length === 0) {
        throw new SymphonyError("response_error", "codex thread/start returned no thread id");
      }
      session.#sessionKey = thread.id;
    } catch (error) {
      agent.kill();
      const symphony = toSymphonyError("response_error", error);
      params.on_event(
        agentEvent(KIND, "startup_failed", {
          agent_process_pid: agent.pid,
          message: symphony.message,
        }),
      );
      return err(symphony.category, symphony.message);
    }

    params.on_event(
      agentEvent(KIND, "session_started", {
        agent_process_pid: agent.pid,
        message: `codex thread ${session.session_key}`,
      }),
    );
    return ok(session);
  }

  // -- protocol plumbing ---------------------------------------------------

  #send(message: Message): void {
    this.agent.write(`${JSON.stringify(message)}\n`);
  }

  #notify(method: string, params: Message): void {
    this.#send({ method, params });
  }

  #request(method: string, params: Message): Promise<Message> {
    const id = this.#nextId++;
    const pending = deferred<Message>();
    this.#pending.set(id, pending);
    this.#send({ id, method, params });
    return pending.promise;
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
            agentEvent(KIND, "malformed", {
              agent_process_pid: this.agent.pid,
              message: briefly(line),
            }),
          );
          continue;
        }
        await this.#handle(message);
      }
    } catch (error) {
      this.params.logger.debug("codex stream ended", {
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      // The stream ended. Anything still waiting must fail rather than hang.
      const exitError = new SymphonyError("agent_exit", "codex app-server exited");
      for (const [id, pending] of this.#pending) {
        this.#pending.delete(id);
        pending.reject(exitError);
      }
      if (this.#turn && !this.#stopped) {
        this.#finishTurn({
          status: "failed",
          turn_key: this.#turn.turnKey ?? "unknown",
          error_category: "agent_exit",
          message: "codex app-server exited mid-turn",
        });
      }
    }
  }

  #finishTurn(outcome: TurnOutcome): void {
    const turn = this.#turn;
    this.#turn = null;
    turn?.resolve(outcome);
  }

  async #handle(message: Message): Promise<void> {
    const id = message.id;
    const method = typeof message.method === "string" ? message.method : null;

    // Response to one of our requests.
    if (typeof id === "number" && method === null) {
      const pending = this.#pending.get(id);
      if (pending) {
        this.#pending.delete(id);
        if (message.error) {
          pending.reject(new SymphonyError("response_error", briefly(message.error)));
        } else {
          pending.resolve((message.result ?? {}) as Message);
        }
      }
      return;
    }
    if (method === null) return;

    this.#turn?.resetSilence();
    const params = (message.params ?? {}) as Message;

    // Terminal turn signals.
    if (method === "turn/completed" || method === "turn/failed" || method === "turn/cancelled") {
      const event =
        method === "turn/completed"
          ? "turn_completed"
          : method === "turn/failed"
            ? "turn_failed"
            : "turn_cancelled";
      const usage = extractUsage((params.usage ?? params.tokenUsage) as unknown);
      this.params.on_event(
        agentEvent(KIND, event, {
          agent_process_pid: this.agent.pid,
          native: truncateNative(message),
          ...(usage
            ? {
                usage: {
                  input_tokens: usage.input,
                  output_tokens: usage.output,
                  total_tokens: usage.total,
                  mode: "cumulative" as const,
                },
              }
            : {}),
        }),
      );
      this.#finishTurn({
        status: method === "turn/completed" ? "completed" : method === "turn/failed" ? "failed" : "cancelled",
        turn_key: this.#turn?.turnKey ?? "unknown",
        error_category: method === "turn/completed" ? null : method === "turn/failed" ? "turn_failed" : "turn_cancelled",
        message: method === "turn/completed" ? null : briefly(params),
      });
      return;
    }

    // Absolute thread token totals.
    if (method === "thread/tokenUsage/updated") {
      const usage = extractUsage(params.total_token_usage ?? params.totalTokenUsage ?? params);
      if (usage) {
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
      return;
    }

    if (method === "thread/rateLimits/updated" || params.rate_limits !== undefined) {
      this.params.on_event(
        agentEvent(KIND, "rate_limits_updated", {
          agent_process_pid: this.agent.pid,
          rate_limits: params.rate_limits ?? params,
        }),
      );
      return;
    }

    // Host-executed tool call.
    if (method === "item/tool/call" && typeof id === "number") {
      const name = String(params.name ?? params.toolName ?? "");
      const rawArgs = params.arguments ?? params.input ?? {};
      const args =
        typeof rawArgs === "string" ? (JSON.parse(rawArgs) as Record<string, unknown>) : (rawArgs as Record<string, unknown>);
      let result: Awaited<ReturnType<StartSessionParams["execute_tool"]>>;
      try {
        result = await this.params.execute_tool(name, args ?? {});
      } catch (error) {
        result = { success: false, error: error instanceof Error ? error.message : String(error) };
      }
      this.#send({ id, result: { success: result.success, output: result.output ?? null, error: result.error ?? null } });
      this.params.on_event(
        agentEvent(KIND, result.success ? "tool_call_completed" : "tool_call_failed", {
          agent_process_pid: this.agent.pid,
          message: `${name}${result.success ? "" : `: ${result.error ?? "failed"}`}`,
        }),
      );
      return;
    }

    // Approval requests. High-trust posture: accept for the session (spec 10.7 example).
    if (typeof id === "number" && (APPROVAL_METHODS.has(method) || LEGACY_APPROVAL_METHODS.has(method))) {
      const decision = APPROVAL_METHODS.has(method) ? "acceptForSession" : "approved_for_session";
      this.params.on_event(
        agentEvent(KIND, "approval_requested", { agent_process_pid: this.agent.pid, message: method }),
      );
      this.#send({ id, result: { decision } });
      this.params.on_event(
        agentEvent(KIND, "approval_resolved", { agent_process_pid: this.agent.pid, message: decision }),
      );
      return;
    }

    // User input requested: documented policy is hard failure, never an indefinite stall.
    if (method === "item/tool/requestUserInput" || method.endsWith("/requestUserInput")) {
      if (typeof id === "number") {
        this.#send({ id, error: { code: -32000, message: "unattended session: user input unavailable" } });
      }
      this.params.on_event(
        agentEvent(KIND, "turn_input_required", { agent_process_pid: this.agent.pid, message: method }),
      );
      this.#finishTurn({
        status: "input_required",
        turn_key: this.#turn?.turnKey ?? "unknown",
        error_category: "turn_input_required",
        message: "agent requested user input in an unattended session",
      });
      return;
    }

    // Any request we do not implement must be answered, or the session stalls (spec 10.7).
    if (typeof id === "number") {
      this.#send({ id, result: { success: false, error: `unsupported method ${method}` } });
      this.params.on_event(
        agentEvent(KIND, "unsupported_tool_call", { agent_process_pid: this.agent.pid, message: method }),
      );
      return;
    }

    this.params.on_event(
      agentEvent(KIND, "notification", {
        agent_process_pid: this.agent.pid,
        message: method,
        native: truncateNative(message),
      }),
    );
  }

  // -- public surface ------------------------------------------------------

  async runTurn(input: TurnInput): Promise<Result<TurnOutcome>> {
    if (this.#stopped) return err("agent_exit", "session already stopped");

    const provider = this.params.runner.provider;
    const pending = deferred<TurnOutcome>();
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;

    const resetSilence = () => {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        this.params.on_event(
          agentEvent(KIND, "turn_timed_out", {
            agent_process_pid: this.agent.pid,
            message: `no output for ${this.params.runner.turn_timeout_ms}ms`,
          }),
        );
        this.#finishTurn({
          status: "timed_out",
          turn_key: this.#turn?.turnKey ?? "unknown",
          error_category: "turn_timeout",
          message: "turn stream went silent",
        });
      }, this.params.runner.turn_timeout_ms);
    };

    this.#turn = { resolve: pending.resolve, turnKey: null, resetSilence };
    resetSilence();

    try {
      const response = await withTimeout(
        this.#request("turn/start", {
          threadId: this.session_key,
          cwd: this.params.workspace_path,
          input: [{ type: "text", text: input.text }],
          ...(input.title ? { title: input.title } : {}),
          ...(provider.approval_policy !== undefined ? { approvalPolicy: provider.approval_policy } : {}),
          ...(provider.turn_sandbox_policy !== undefined
            ? { sandboxPolicy: provider.turn_sandbox_policy }
            : {}),
        }),
        this.params.runner.read_timeout_ms,
        "response_timeout",
        "codex turn/start timed out",
      );
      const turnId = (response as { turn?: { id?: unknown } }).turn?.id;
      const turnKey = typeof turnId === "string" && turnId.length > 0 ? turnId : `turn-${input.turn_number}`;
      if (this.#turn) this.#turn.turnKey = turnKey;
      this.params.on_event(
        agentEvent(KIND, "turn_started", { agent_process_pid: this.agent.pid, message: turnKey }),
      );
    } catch (error) {
      if (silenceTimer) clearTimeout(silenceTimer);
      this.#turn = null;
      const symphony = toSymphonyError("response_error", error);
      return err(symphony.category, symphony.message);
    }

    const outcome = await pending.promise;
    if (silenceTimer) clearTimeout(silenceTimer);
    return ok(outcome);
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#finishTurn({
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

export const codexAppServerAdapter: AgentAdapter = {
  kind: KIND,
  capabilities: () => ({ ...CAPABILITIES }),
  validateConfig(runner: RunnerConfig) {
    const command = runner.command ?? DEFAULT_COMMAND;
    if (command.trim().length === 0) {
      return err("invalid_runner_config", "runner.command must be a non-empty shell command");
    }
    return ok(undefined);
  },
  sensitiveEnvironmentNames(runner: RunnerConfig) {
    // Codex authenticates out of band; only what the workflow explicitly injects is ours to redact.
    return Object.keys(runner.env);
  },
  startSession(params) {
    return CodexSession.open(params) as Promise<Result<AgentSession>>;
  },
};
