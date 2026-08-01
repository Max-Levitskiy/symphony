/**
 * Typed configuration layer (spec section 6, and 5.3 as rewritten by delta D-006/D-007).
 *
 * Resolution order: front matter -> defaults -> `$VAR` indirection -> coercion and validation.
 * Environment variables never globally override YAML; they apply only where a value explicitly
 * references them.
 */

import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { err, ok, type Result } from "../errors.ts";
import type { WorkflowDefinition } from "../types.ts";

export type TrackerConfig = {
  kind: string;
  provider: Record<string, unknown>;
  required_labels: string[];
  active_states: string[];
  terminal_states: string[];
};

export type RunnerConfig = {
  kind: string;
  command: string | null;
  provider: Record<string, unknown>;
  env: Record<string, string>;
  require_client_tools: boolean;
  turn_timeout_ms: number;
  read_timeout_ms: number;
  stall_timeout_ms: number;
};

export type HooksConfig = {
  after_create: string | null;
  before_run: string | null;
  after_run: string | null;
  before_remove: string | null;
  timeout_ms: number;
};

export type AgentConfig = {
  max_concurrent_agents: number;
  max_turns: number;
  max_retry_backoff_ms: number;
  max_concurrent_agents_by_state: Record<string, number>;
};

export type EffectiveConfig = {
  workflow_path: string;
  prompt_template: string;
  tracker: TrackerConfig;
  polling: { interval_ms: number };
  workspace: { root: string };
  hooks: HooksConfig;
  agent: AgentConfig;
  runner: RunnerConfig;
  server: { port: number | null };
  /** Non-fatal operator-visible notes, for example the deprecated `codex` block. */
  warnings: string[];
};

export const DEFAULTS = {
  polling_interval_ms: 30_000,
  hooks_timeout_ms: 60_000,
  max_concurrent_agents: 10,
  max_turns: 20,
  max_retry_backoff_ms: 300_000,
  turn_timeout_ms: 3_600_000,
  read_timeout_ms: 5_000,
  stall_timeout_ms: 300_000,
} as const;

type Env = Record<string, string | undefined>;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Resolve `$NAME` / `${NAME}` indirection. Only applied to values that explicitly contain a token,
 * so a literal value is never rewritten from the ambient environment (spec 6.1).
 */
export function resolveEnvTokens(value: string, env: Env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a, b) => {
    const name = (a ?? b) as string;
    return env[name] ?? "";
  });
}

/** Path coercion: `~` expansion, `$VAR` expansion, then absolute resolution (spec 6.1). */
export function coercePath(value: string, baseDir: string, env: Env): string {
  let out = resolveEnvTokens(value, env);
  if (out === "~") out = homedir();
  else if (out.startsWith("~/")) out = resolve(homedir(), out.slice(2));
  return isAbsolute(out) ? resolve(out) : resolve(baseDir, out);
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function asPositiveInt(value: unknown, fallback: number): number | null {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

function asScript(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : value;
}

/**
 * Normalize the deprecated `codex` front-matter block into `runner` (spec 5.3.6, delta D-006).
 *
 * This is a translation, not a second code path: everything downstream sees only `runner`.
 */
export function normalizeLegacyRunner(
  config: Record<string, unknown>,
  warnings: string[],
): Record<string, unknown> {
  const runner = config.runner;
  const legacy = config.codex;

  if (isPlainObject(runner)) {
    if (legacy !== undefined) {
      warnings.push(
        "both `runner` and `codex` are present in WORKFLOW.md; `codex` is deprecated and is being ignored entirely",
      );
    }
    return runner;
  }
  if (!isPlainObject(legacy)) return {};

  warnings.push(
    "`codex` front-matter block is deprecated; rename it to `runner` with kind: codex-app-server",
  );

  const { command, turn_timeout_ms, read_timeout_ms, stall_timeout_ms, ...provider } = legacy;
  const synthesized: Record<string, unknown> = {
    kind: "codex-app-server",
    provider,
  };
  if (command !== undefined) synthesized.command = command;
  if (turn_timeout_ms !== undefined) synthesized.turn_timeout_ms = turn_timeout_ms;
  if (read_timeout_ms !== undefined) synthesized.read_timeout_ms = read_timeout_ms;
  if (stall_timeout_ms !== undefined) synthesized.stall_timeout_ms = stall_timeout_ms;
  return synthesized;
}

export function resolveConfig(
  workflow: WorkflowDefinition,
  workflowPath: string,
  env: Env = process.env,
): Result<EffectiveConfig> {
  const config = workflow.config;
  const baseDir = dirname(resolve(workflowPath));
  const warnings: string[] = [];

  // --- tracker -------------------------------------------------------------
  const trackerRaw = isPlainObject(config.tracker) ? config.tracker : {};
  if (typeof trackerRaw.kind !== "string" || trackerRaw.kind.trim().length === 0) {
    return err("invalid_config", "tracker.kind is required");
  }
  const trackerProvider = isPlainObject(trackerRaw.provider) ? { ...trackerRaw.provider } : {};
  for (const [key, value] of Object.entries(trackerProvider)) {
    if (typeof value === "string" && value.includes("$")) {
      trackerProvider[key] = resolveEnvTokens(value, env);
    }
  }
  const tracker: TrackerConfig = {
    kind: trackerRaw.kind.trim(),
    provider: trackerProvider,
    required_labels: asStringList(trackerRaw.required_labels),
    active_states: asStringList(trackerRaw.active_states),
    terminal_states: asStringList(trackerRaw.terminal_states),
  };

  // --- polling -------------------------------------------------------------
  const pollingRaw = isPlainObject(config.polling) ? config.polling : {};
  const intervalMs = asPositiveInt(pollingRaw.interval_ms, DEFAULTS.polling_interval_ms);
  if (intervalMs === null) {
    return err("invalid_config", "polling.interval_ms must be a positive integer");
  }

  // --- workspace -----------------------------------------------------------
  const workspaceRaw = isPlainObject(config.workspace) ? config.workspace : {};
  const rootValue =
    typeof workspaceRaw.root === "string" && workspaceRaw.root.trim().length > 0
      ? workspaceRaw.root
      : resolve(tmpdir(), "symphony_workspaces");
  const workspaceRoot = coercePath(rootValue, baseDir, env);

  // --- hooks ---------------------------------------------------------------
  const hooksRaw = isPlainObject(config.hooks) ? config.hooks : {};
  const hookTimeout = asPositiveInt(hooksRaw.timeout_ms, DEFAULTS.hooks_timeout_ms);
  if (hookTimeout === null) {
    return err("invalid_config", "hooks.timeout_ms must be a positive integer");
  }
  const hooks: HooksConfig = {
    after_create: asScript(hooksRaw.after_create),
    before_run: asScript(hooksRaw.before_run),
    after_run: asScript(hooksRaw.after_run),
    before_remove: asScript(hooksRaw.before_remove),
    timeout_ms: hookTimeout,
  };

  // --- agent (scheduling) --------------------------------------------------
  const agentRaw = isPlainObject(config.agent) ? config.agent : {};
  const maxConcurrent = asPositiveInt(agentRaw.max_concurrent_agents, DEFAULTS.max_concurrent_agents);
  if (maxConcurrent === null) {
    return err("invalid_config", "agent.max_concurrent_agents must be a positive integer");
  }
  const maxTurns = asPositiveInt(agentRaw.max_turns, DEFAULTS.max_turns);
  if (maxTurns === null) {
    return err("invalid_config", "agent.max_turns must be a positive integer");
  }
  const maxBackoff = asPositiveInt(agentRaw.max_retry_backoff_ms, DEFAULTS.max_retry_backoff_ms);
  if (maxBackoff === null) {
    return err("invalid_config", "agent.max_retry_backoff_ms must be a positive integer");
  }
  // Invalid per-state entries are ignored rather than fatal (spec 5.3.5).
  const byState: Record<string, number> = {};
  if (isPlainObject(agentRaw.max_concurrent_agents_by_state)) {
    for (const [state, limit] of Object.entries(agentRaw.max_concurrent_agents_by_state)) {
      if (typeof limit === "number" && Number.isInteger(limit) && limit > 0) {
        byState[state.trim().toLowerCase()] = limit;
      }
    }
  }

  // --- runner (agent runtime) ---------------------------------------------
  const runnerRaw = normalizeLegacyRunner(config, warnings);
  if (typeof runnerRaw.kind !== "string" || runnerRaw.kind.trim().length === 0) {
    return err(
      "invalid_config",
      "runner.kind is required (or a deprecated `codex` block, which normalizes to kind: codex-app-server)",
    );
  }
  const runnerProvider = isPlainObject(runnerRaw.provider) ? { ...runnerRaw.provider } : {};
  for (const [key, value] of Object.entries(runnerProvider)) {
    if (typeof value === "string" && value.includes("$")) {
      runnerProvider[key] = resolveEnvTokens(value, env);
    }
  }
  const runnerEnv: Record<string, string> = {};
  if (isPlainObject(runnerRaw.env)) {
    for (const [key, value] of Object.entries(runnerRaw.env)) {
      if (typeof value !== "string") {
        return err("invalid_config", `runner.env.${key} must be a string`);
      }
      runnerEnv[key] = value.includes("$") ? resolveEnvTokens(value, env) : value;
    }
  }
  const turnTimeout = asPositiveInt(runnerRaw.turn_timeout_ms, DEFAULTS.turn_timeout_ms);
  const readTimeout = asPositiveInt(runnerRaw.read_timeout_ms, DEFAULTS.read_timeout_ms);
  if (turnTimeout === null || readTimeout === null) {
    return err("invalid_config", "runner.turn_timeout_ms and runner.read_timeout_ms must be positive integers");
  }
  // stall_timeout_ms is the one timeout where <= 0 is meaningful: it disables stall detection.
  const stallRaw = runnerRaw.stall_timeout_ms;
  let stallTimeout: number = DEFAULTS.stall_timeout_ms;
  if (stallRaw !== undefined && stallRaw !== null) {
    if (typeof stallRaw !== "number" || !Number.isInteger(stallRaw)) {
      return err("invalid_config", "runner.stall_timeout_ms must be an integer");
    }
    stallTimeout = stallRaw;
  }

  const runner: RunnerConfig = {
    kind: runnerRaw.kind.trim(),
    command:
      typeof runnerRaw.command === "string" && runnerRaw.command.trim().length > 0
        ? runnerRaw.command
        : null,
    provider: runnerProvider,
    env: runnerEnv,
    require_client_tools: runnerRaw.require_client_tools === true,
    turn_timeout_ms: turnTimeout,
    read_timeout_ms: readTimeout,
    stall_timeout_ms: stallTimeout,
  };

  // --- server extension ----------------------------------------------------
  const serverRaw = isPlainObject(config.server) ? config.server : {};
  let port: number | null = null;
  if (serverRaw.port !== undefined && serverRaw.port !== null) {
    if (typeof serverRaw.port !== "number" || !Number.isInteger(serverRaw.port) || serverRaw.port < 0) {
      return err("invalid_config", "server.port must be a non-negative integer");
    }
    port = serverRaw.port;
  }

  return ok({
    workflow_path: resolve(workflowPath),
    prompt_template: workflow.prompt_template,
    tracker,
    polling: { interval_ms: intervalMs },
    workspace: { root: workspaceRoot },
    hooks,
    agent: {
      max_concurrent_agents: maxConcurrent,
      max_turns: maxTurns,
      max_retry_backoff_ms: maxBackoff,
      max_concurrent_agents_by_state: byState,
    },
    runner,
    server: { port },
    warnings,
  });
}
