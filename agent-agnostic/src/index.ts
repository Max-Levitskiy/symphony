/**
 * Public surface of the agent-agnostic Symphony implementation.
 *
 * Adding a coding agent means implementing `AgentAdapter` and registering it. Nothing in
 * `src/orchestrator/` should need to change; if it does, the abstraction in forked SPEC.md
 * section 10 is wrong and the fix belongs in DELTA.md.
 */

export * from "./types.ts";
export * from "./errors.ts";
export { Logger, type LogLevel, type LogContext } from "./logging.ts";

export { parseWorkflow, loadWorkflowFile } from "./workflow/loader.ts";
export {
  resolveConfig,
  normalizeLegacyRunner,
  resolveEnvTokens,
  coercePath,
  DEFAULTS,
  type EffectiveConfig,
  type RunnerConfig,
  type TrackerConfig,
  type HooksConfig,
  type AgentConfig,
} from "./config/schema.ts";

export { renderTemplate } from "./prompt/template.ts";
export { buildTurnPrompt, DEFAULT_PROMPT } from "./prompt/builder.ts";

export { WorkspaceManager, workspaceKey, assertInsideRoot } from "./workspace/manager.ts";

export * from "./agent/types.ts";
export { AgentRegistry, defaultAgentRegistry } from "./agent/registry.ts";
export { codexAppServerAdapter } from "./agent/codex-app-server.ts";
export { claudeCodeAdapter } from "./agent/claude-code.ts";
export { cliExecAdapter } from "./agent/cli-exec.ts";

export { normalizeIssue, type TrackerAdapter, type TrackerContext } from "./tracker/types.ts";
export { TrackerRegistry, defaultTrackerRegistry } from "./tracker/registry.ts";
export { MemoryTracker, createMemoryTracker } from "./tracker/memory.ts";
export { GitHubTracker, createGitHubTracker } from "./tracker/github.ts";

export {
  Orchestrator,
  sortForDispatch,
  type OrchestratorOptions,
  type Snapshot,
  type RunningEntry,
} from "./orchestrator/orchestrator.ts";
export { runAgentAttempt, issueRoutable, childEnvironment } from "./orchestrator/worker.ts";
export { startHttpServer, type HttpServer } from "./http/server.ts";
