/**
 * `cli-exec` adapter — forked spec Appendix B.3.
 *
 * The generic escape hatch: run a command, hand it a prompt, read the exit code. Every capability
 * is `false`, which makes this adapter the working proof that the section 10 boundary is real —
 * an agent with no session model, no streaming protocol, and no telemetry is still orchestrable,
 * because the workspace carries state between turns rather than the agent's memory.
 */

import { err, ok, type Result } from "../errors.ts";
import type { RunnerConfig } from "../config/schema.ts";
import {
  agentEvent,
  type AgentAdapter,
  type AgentCapabilities,
  type AgentSession,
  type StartSessionParams,
  type TurnInput,
  type TurnOutcome,
} from "./types.ts";
import { briefly } from "./process.ts";

const KIND = "cli-exec";

const CAPABILITIES: AgentCapabilities = {
  session_continuation: false,
  streaming_events: false,
  client_tools: false,
  approvals: false,
  cancellation: false,
  usage_reporting: false,
  rate_limit_reporting: false,
};

type Settings = {
  delivery: "stdin" | "argv";
  placeholder: string;
  successExitCodes: number[];
  captureBytes: number;
};

function settingsOf(runner: RunnerConfig): Settings {
  const provider = runner.provider;
  const codes = Array.isArray(provider.success_exit_codes)
    ? provider.success_exit_codes.filter((c): c is number => typeof c === "number")
    : [0];
  return {
    delivery: provider.prompt_delivery === "argv" ? "argv" : "stdin",
    placeholder:
      typeof provider.prompt_arg_placeholder === "string" ? provider.prompt_arg_placeholder : "{{prompt}}",
    successExitCodes: codes.length > 0 ? codes : [0],
    captureBytes:
      typeof provider.capture_output_bytes === "number" && provider.capture_output_bytes > 0
        ? provider.capture_output_bytes
        : 65_536,
  };
}

class CliExecSession implements AgentSession {
  readonly capabilities = CAPABILITIES;
  readonly session_key = `cli-${crypto.randomUUID()}`;
  agent_process_pid: string | null = null;
  #current: Bun.Subprocess | null = null;
  #stopped = false;

  constructor(
    private readonly params: StartSessionParams,
    private readonly settings: Settings,
  ) {}

  async runTurn(input: TurnInput): Promise<Result<TurnOutcome>> {
    if (this.#stopped) return err("agent_exit", "session already stopped");
    const turnKey = `turn-${input.turn_number}`;
    const command = this.params.runner.command!;

    // Every turn is a fresh process. `session_key` stays stable across them so logs and snapshots
    // remain correlated (spec 10.5).
    const resolved =
      this.settings.delivery === "argv"
        ? command.split(this.settings.placeholder).join(shellQuote(input.text))
        : command;

    const proc = Bun.spawn(["bash", "-lc", resolved], {
      cwd: this.params.workspace_path,
      env: this.params.environment,
      stdin: this.settings.delivery === "stdin" ? new TextEncoder().encode(`${input.text}\n`) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.#current = proc;
    this.agent_process_pid = proc.pid ? String(proc.pid) : null;

    this.params.on_event(
      agentEvent(KIND, "turn_started", { agent_process_pid: this.agent_process_pid, message: turnKey }),
    );

    let output = "";
    let timer: ReturnType<typeof setTimeout> | null = null;

    // The command may spawn children that keep the pipes open after it is killed, so the timeout
    // must win the race outright rather than wait for the streams to close.
    const finished = (async () => {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      output = `${stdout}${stderr}`.slice(0, this.settings.captureBytes).trim();
      await proc.exited;
      return "done" as const;
    })();
    const expired = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // already gone
        }
        resolve("timeout");
      }, this.params.runner.turn_timeout_ms);
    });

    const timedOut = (await Promise.race([finished, expired])) === "timeout";
    if (timer) clearTimeout(timer);
    finished.catch(() => {});
    this.#current = null;

    if (timedOut) {
      this.params.on_event(
        agentEvent(KIND, "turn_timed_out", {
          agent_process_pid: this.agent_process_pid,
          message: `exceeded ${this.params.runner.turn_timeout_ms}ms`,
        }),
      );
      return ok({
        status: "timed_out",
        turn_key: turnKey,
        error_category: "turn_timeout",
        message: `command exceeded runner.turn_timeout_ms`,
      });
    }
    if (this.#stopped) {
      return ok({
        status: "cancelled",
        turn_key: turnKey,
        error_category: "turn_cancelled",
        message: "session stopped",
      });
    }

    const code = proc.exitCode ?? -1;
    const succeeded = this.settings.successExitCodes.includes(code);
    this.params.on_event(
      agentEvent(KIND, succeeded ? "turn_completed" : "turn_failed", {
        agent_process_pid: this.agent_process_pid,
        message: briefly(output || `exit ${code}`),
      }),
    );
    return ok({
      status: succeeded ? "completed" : "failed",
      turn_key: turnKey,
      error_category: succeeded ? null : "turn_failed",
      message: succeeded ? null : `exit ${code}: ${briefly(output)}`,
    });
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    try {
      this.#current?.kill();
    } catch {
      // already gone
    }
  }
}

function shellQuote(text: string): string {
  return `'${text.split("'").join(`'\\''`)}'`;
}

export const cliExecAdapter: AgentAdapter = {
  kind: KIND,
  capabilities: () => ({ ...CAPABILITIES }),
  validateConfig(runner: RunnerConfig) {
    if (!runner.command || runner.command.trim().length === 0) {
      return err("invalid_runner_config", "cli-exec requires an explicit runner.command");
    }
    const provider = runner.provider;
    if (provider.prompt_delivery !== undefined && !["stdin", "argv"].includes(String(provider.prompt_delivery))) {
      return err("invalid_runner_config", "runner.provider.prompt_delivery must be 'stdin' or 'argv'");
    }
    if (provider.prompt_delivery === "argv") {
      const placeholder =
        typeof provider.prompt_arg_placeholder === "string" ? provider.prompt_arg_placeholder : "{{prompt}}";
      if (!runner.command.includes(placeholder)) {
        return err(
          "invalid_runner_config",
          `runner.command must contain the placeholder '${placeholder}' when prompt_delivery is 'argv'`,
        );
      }
    }
    return ok(undefined);
  },
  sensitiveEnvironmentNames(runner: RunnerConfig) {
    return Object.keys(runner.env);
  },
  async startSession(params: StartSessionParams): Promise<Result<AgentSession>> {
    const validation = cliExecAdapter.validateConfig(params.runner);
    if (!validation.ok) return validation;

    const session = new CliExecSession(params, settingsOf(params.runner));
    if (params.tools.length > 0) {
      params.on_event(
        agentEvent(KIND, "client_tools_unavailable", {
          message: `${params.tools.length} tracker tool(s) not advertised; cli-exec has no tool protocol`,
        }),
      );
    }
    params.on_event(agentEvent(KIND, "session_started", { message: session.session_key }));
    return ok(session);
  },
};
