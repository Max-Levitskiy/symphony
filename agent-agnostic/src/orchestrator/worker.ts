/**
 * Worker attempt: workspace + prompt + selected agent adapter (spec 10.9, 16.5).
 *
 * This is where the fork's central claim is cashed out. The worker reads capabilities and adapts;
 * it never asks which agent it is talking to.
 */

import type { EffectiveConfig } from "../config/schema.ts";
import type { Logger } from "../logging.ts";
import type { Issue } from "../types.ts";
import type { AgentAdapter, AgentEvent, ToolSpec } from "../agent/types.ts";
import type { TrackerAdapter } from "../tracker/types.ts";
import { WorkspaceManager } from "../workspace/manager.ts";
import { buildTurnPrompt } from "../prompt/builder.ts";
import { normalizeState } from "../types.ts";
import { SymphonyError } from "../errors.ts";

export type WorkerExit = { reason: "normal" | "error"; error?: string };

export type WorkerContext = {
  issue: Issue;
  attempt: number | null;
  config: EffectiveConfig;
  workspaces: WorkspaceManager;
  tracker: TrackerAdapter;
  adapter: AgentAdapter;
  logger: Logger;
  onEvent: (event: AgentEvent) => void;
  onWorkspace?: (path: string) => void;
  /** Set by the orchestrator when reconciliation or stall detection terminates the run. */
  signal: AbortSignal;
};

/** Spec 8.2: routable means adapter-dispatchable plus every required label present. */
export function issueRoutable(issue: Issue, requiredLabels: string[]): boolean {
  if (!issue.dispatchable) return false;
  const labels = new Set(issue.labels.map((l) => l.trim().toLowerCase()));
  return requiredLabels.every((label) => {
    const wanted = label.trim().toLowerCase();
    return wanted.length > 0 && labels.has(wanted);
  });
}

/** Build the agent child environment: host env minus tracker secrets, plus `runner.env`. */
export function childEnvironment(
  config: EffectiveConfig,
  tracker: TrackerAdapter,
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const removed = new Set(tracker.secretEnvironmentNames?.() ?? []);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || removed.has(key)) continue;
    env[key] = value;
  }
  return { ...env, ...config.runner.env };
}

export async function runAgentAttempt(ctx: WorkerContext): Promise<WorkerExit> {
  const { issue, config, logger } = ctx;
  const capabilities = ctx.adapter.capabilities(config.runner);

  let workspacePath: string;
  try {
    const workspace = await ctx.workspaces.ensure(issue.identifier, {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
    });
    workspacePath = workspace.path;
    ctx.onWorkspace?.(workspacePath);
  } catch (error) {
    return { reason: "error", error: `workspace error: ${describe(error)}` };
  }

  const beforeRun = await ctx.workspaces.runHook("before_run", workspacePath, {
    issue_id: issue.id,
    issue_identifier: issue.identifier,
  });
  if (beforeRun.ran && !beforeRun.ok) {
    return { reason: "error", error: "before_run hook error" };
  }

  const available = ctx.tracker.agentToolSpecs?.() ?? [];
  const tools: ToolSpec[] = capabilities.client_tools ? available : [];
  if (!capabilities.client_tools && available.length > 0) {
    // Documented fallback for `client_tools=false` (spec 10.3): say so once, then run anyway.
    // Emitted here rather than per adapter so every adapter gets the behavior for free.
    ctx.onEvent({
      event: "client_tools_unavailable",
      timestamp: new Date().toISOString(),
      agent_kind: config.runner.kind,
      message: `${available.length} tracker tool(s) not advertised: adapter '${config.runner.kind}' declares client_tools=false`,
    });
  }

  const started = await ctx.adapter.startSession({
    workspace_path: workspacePath,
    issue,
    runner: config.runner,
    tools,
    execute_tool: async (name, args) => {
      if (!ctx.tracker.executeAgentTool) {
        return { success: false, error: `tracker '${ctx.tracker.kind}' exposes no agent tools` };
      }
      // Tools execute host-side with the configured tracker credential; the child sees results,
      // never a raw token (spec 11.5).
      return ctx.tracker.executeAgentTool(name, args, { issue });
    },
    on_event: ctx.onEvent,
    environment: childEnvironment(config, ctx.tracker),
    logger,
  });

  if (!started.ok) {
    await ctx.workspaces.runHookBestEffort("after_run", workspacePath, {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
    });
    return { reason: "error", error: `agent session startup error: ${started.error.message}` };
  }
  const session = started.value;

  // Termination must interrupt an in-flight turn, not wait politely for it to finish. Adapters
  // that declare `cancellation=false` implement stop() as a process kill (spec 10.3).
  const onAbort = () => void session.stop().catch(() => {});
  ctx.signal.addEventListener("abort", onAbort, { once: true });

  const finish = async (exit: WorkerExit): Promise<WorkerExit> => {
    ctx.signal.removeEventListener("abort", onAbort);
    await session.stop().catch(() => {});
    await ctx.workspaces.runHookBestEffort("after_run", workspacePath, {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
    });
    return exit;
  };

  let current = issue;
  let turnNumber = 1;

  for (;;) {
    if (ctx.signal.aborted) return finish({ reason: "error", error: "terminated by orchestrator" });

    // Turn 1 always carries the task. Later turns carry it too when the agent cannot remember
    // (spec 7.1, delta D-008).
    const fullPrompt = turnNumber === 1 || !capabilities.session_continuation;
    const prompt = buildTurnPrompt({
      template: config.prompt_template,
      issue: current,
      attempt: ctx.attempt,
      turn_number: turnNumber,
      max_turns: config.agent.max_turns,
      full_prompt: fullPrompt,
    });
    if (!prompt.ok) {
      return finish({ reason: "error", error: `prompt error: ${prompt.error.message}` });
    }

    const outcome = await session.runTurn({
      turn_number: turnNumber,
      kind: turnNumber === 1 ? "initial" : "continuation",
      text: prompt.value,
      title: `${current.identifier}: ${current.title}`,
    });

    if (ctx.signal.aborted) return finish({ reason: "error", error: "terminated by orchestrator" });

    if (!outcome.ok) {
      return finish({ reason: "error", error: `agent turn error: ${outcome.error.message}` });
    }
    if (outcome.value.status !== "completed") {
      return finish({
        reason: "error",
        error: `agent turn ${outcome.value.status}${outcome.value.message ? `: ${outcome.value.message}` : ""}`,
      });
    }

    const refreshed = await ctx.tracker.fetchIssuesByIds([current.id]);
    if (!refreshed.ok) {
      return finish({ reason: "error", error: `issue state refresh error: ${refreshed.error.message}` });
    }
    const next = refreshed.value.find((i) => i.id === current.id);
    if (!next) break; // no longer visible: nothing more to do in this worker

    current = next;

    const active = config.tracker.active_states.map(normalizeState);
    if (!active.includes(normalizeState(current.state))) break;
    if (!issueRoutable(current, config.tracker.required_labels)) break;
    if (turnNumber >= config.agent.max_turns) break;

    turnNumber += 1;
    logger.debug("continuing on the same issue", {
      issue_id: current.id,
      issue_identifier: current.identifier,
      turn: turnNumber,
      session_continuation: capabilities.session_continuation,
    });
  }

  return finish({ reason: "normal" });
}

function describe(error: unknown): string {
  if (error instanceof SymphonyError) return `${error.category}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
