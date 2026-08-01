/**
 * Orchestrator (spec sections 7, 8, 14, 16).
 *
 * The only component that mutates scheduling state. Workers report outcomes back; every outcome
 * becomes an explicit transition here. Nothing in this file knows which coding agent is running —
 * that is the whole point of the fork.
 */

import { watch, type FSWatcher } from "node:fs";
import { err, ok, type Result, type SymphonyError } from "../errors.ts";
import { Logger } from "../logging.ts";
import { loadWorkflowFile } from "../workflow/loader.ts";
import { resolveConfig, type EffectiveConfig } from "../config/schema.ts";
import { WorkspaceManager } from "../workspace/manager.ts";
import { AgentRegistry, defaultAgentRegistry } from "../agent/registry.ts";
import { TrackerRegistry, defaultTrackerRegistry } from "../tracker/registry.ts";
import type { TrackerAdapter } from "../tracker/types.ts";
import type { AgentAdapter, AgentEvent } from "../agent/types.ts";
import {
  emptyLiveSession,
  normalizeState,
  type AgentTotals,
  type Issue,
  type LiveSession,
  type RetryEntry,
} from "../types.ts";
import { issueRoutable, runAgentAttempt } from "./worker.ts";

const CONTINUATION_DELAY_MS = 1_000; // spec 8.4
const FAILURE_BASE_DELAY_MS = 10_000; // spec 8.4
const RECENT_EVENT_LIMIT = 25;

export type RunningEntry = {
  issue: Issue;
  identifier: string;
  session: LiveSession;
  started_at: string;
  started_at_ms: number;
  retry_attempt: number | null;
  workspace_path: string | null;
  last_error: string | null;
  recent_events: { at: string; event: string; message: string }[];
  controller: AbortController;
  done: Promise<void>;
};

export type OrchestratorOptions = {
  workflowPath: string;
  logger?: Logger;
  agents?: AgentRegistry;
  trackers?: TrackerRegistry;
  env?: Record<string, string | undefined>;
  /** Injected for tests: monotonic clock in milliseconds. */
  now?: () => number;
};

export type Snapshot = {
  generated_at: string;
  agent_kind: string;
  counts: { running: number; retrying: number };
  running: {
    issue_id: string;
    issue_identifier: string;
    issue_url: string | null;
    state: string;
    agent_kind: string;
    session_id: string | null;
    turn_count: number;
    usage_reported: boolean;
    last_event: string | null;
    last_message: string | null;
    started_at: string;
    last_event_at: string | null;
    tokens: { input_tokens: number; output_tokens: number; total_tokens: number };
  }[];
  retrying: {
    issue_id: string;
    issue_identifier: string;
    issue_url: string | null;
    attempt: number;
    due_at: string;
    error: string | null;
  }[];
  agent_totals: AgentTotals;
  rate_limits: unknown;
  warnings: string[];
};

export class Orchestrator {
  readonly logger: Logger;
  readonly agents: AgentRegistry;
  readonly trackers: TrackerRegistry;

  #workflowPath: string;
  #env: Record<string, string | undefined>;
  #now: () => number;

  #config: EffectiveConfig | null = null;
  #configError: SymphonyError | null = null;
  #tracker: TrackerAdapter | null = null;
  #workspaces: WorkspaceManager | null = null;

  #running = new Map<string, RunningEntry>();
  #claimed = new Set<string>();
  #retries = new Map<string, RetryEntry>();
  #completed = new Set<string>();
  #totals: AgentTotals = { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 };
  #rateLimits: unknown = null;
  #urls = new Map<string, string | null>();

  #tickTimer: ReturnType<typeof setTimeout> | null = null;
  #watcher: FSWatcher | null = null;
  #stopped = true;
  #ticking = false;
  #pendingRefresh = false;

  constructor(options: OrchestratorOptions) {
    this.#workflowPath = options.workflowPath;
    this.logger = options.logger ?? new Logger({ level: "info" });
    this.agents = options.agents ?? defaultAgentRegistry();
    this.trackers = options.trackers ?? defaultTrackerRegistry();
    this.#env = options.env ?? process.env;
    this.#now = options.now ?? (() => Date.now());
  }

  get config(): EffectiveConfig | null {
    return this.#config;
  }

  // -- configuration --------------------------------------------------------

  /**
   * Re-read WORKFLOW.md and re-apply it. An invalid reload never crashes the service and never
   * replaces a known-good configuration (spec 6.2).
   */
  async reload(): Promise<Result<EffectiveConfig>> {
    const workflow = await loadWorkflowFile(this.#workflowPath);
    if (!workflow.ok) {
      this.#configError = workflow.error;
      this.logger.error("workflow load failed", {
        category: workflow.error.category,
        reason: workflow.error.message,
        path: this.#workflowPath,
      });
      return workflow;
    }

    const resolved = resolveConfig(workflow.value, this.#workflowPath, this.#env);
    if (!resolved.ok) {
      this.#configError = resolved.error;
      this.logger.error("workflow config invalid", {
        category: resolved.error.category,
        reason: resolved.error.message,
      });
      return resolved;
    }

    const config = resolved.value;
    for (const warning of config.warnings) this.logger.warn(warning, { path: this.#workflowPath });

    const tracker = this.trackers.create(config.tracker, this.logger);
    if (!tracker.ok) {
      this.#configError = tracker.error;
      this.logger.error("tracker adapter unavailable", {
        category: tracker.error.category,
        reason: tracker.error.message,
      });
      return tracker;
    }

    const agent = this.#validateRunner(config);
    if (!agent.ok) {
      this.#configError = agent.error;
      this.logger.error("agent adapter unavailable", {
        category: agent.error.category,
        reason: agent.error.message,
      });
      return agent;
    }

    // Values the agent adapter considers sensitive never reach a log line.
    const sensitive = agent.value.sensitiveEnvironmentNames(config.runner);
    this.logger.redactValues(
      sensitive.map((name) => config.runner.env[name] ?? this.#env[name] ?? "").filter((v) => v.length > 0),
    );

    this.#config = config;
    this.#configError = null;
    this.#tracker = tracker.value;
    this.#workspaces = new WorkspaceManager({
      root: config.workspace.root,
      hooks: config.hooks,
      logger: this.logger,
    });
    return ok(config);
  }

  #validateRunner(config: EffectiveConfig): Result<AgentAdapter> {
    const adapter = this.agents.resolve(config.runner.kind);
    if (!adapter.ok) return adapter;

    const valid = adapter.value.validateConfig(config.runner);
    if (!valid.ok) return err(valid.error.category, valid.error.message);

    if (config.runner.require_client_tools && !adapter.value.capabilities(config.runner).client_tools) {
      return err(
        "agent_capability_unsupported",
        `runner.require_client_tools is set but adapter '${config.runner.kind}' declares client_tools=false`,
      );
    }
    return adapter;
  }

  /** Dispatch preflight (spec 6.3). Runs at startup and before every dispatch cycle. */
  async validateDispatch(): Promise<Result<EffectiveConfig>> {
    const reloaded = await this.reload();
    return reloaded;
  }

  // -- lifecycle ------------------------------------------------------------

  async start(): Promise<Result<void>> {
    const validation = await this.validateDispatch();
    if (!validation.ok) return err(validation.error.category, validation.error.message);

    this.#stopped = false;
    await this.startupCleanup();
    this.#watchWorkflow();
    this.#scheduleTick(0);
    this.logger.info("orchestrator started", {
      workflow: this.#workflowPath,
      tracker_kind: this.#config!.tracker.kind,
      agent_kind: this.#config!.runner.kind,
      poll_interval_ms: this.#config!.polling.interval_ms,
    });
    return ok(undefined);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#tickTimer) clearTimeout(this.#tickTimer);
    this.#tickTimer = null;
    this.#watcher?.close();
    this.#watcher = null;

    for (const entry of this.#retries.values()) {
      if (entry.timer_handle) clearTimeout(entry.timer_handle);
    }
    this.#retries.clear();

    const pending = [...this.#running.values()].map(async (entry) => {
      entry.controller.abort();
      await entry.done.catch(() => {});
    });
    await Promise.all(pending);
    this.logger.info("orchestrator stopped", {});
  }

  /** Spec 8.6: remove stale workspaces for issues already terminal. */
  async startupCleanup(): Promise<void> {
    if (!this.#config || !this.#tracker || !this.#workspaces) return;
    const terminal = await this.#tracker.fetchIssuesByStates(this.#config.tracker.terminal_states);
    if (!terminal.ok) {
      this.logger.warn("startup terminal cleanup skipped", { reason: terminal.error.message });
      return;
    }
    for (const issue of terminal.value) {
      await this.#workspaces.remove(issue.identifier, {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
      });
    }
  }

  #watchWorkflow(): void {
    try {
      this.#watcher = watch(this.#workflowPath, { persistent: false }, () => {
        void this.reload().then((result) => {
          if (result.ok) this.logger.info("workflow reloaded", { path: this.#workflowPath });
        });
      });
    } catch (error) {
      // Watch is best-effort; every tick re-validates defensively anyway (spec 6.2).
      this.logger.warn("workflow watch unavailable", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #scheduleTick(delayMs: number): void {
    if (this.#stopped) return;
    if (this.#tickTimer) clearTimeout(this.#tickTimer);
    this.#tickTimer = setTimeout(() => {
      void this.tick();
    }, delayMs);
  }

  /** Queue an immediate poll + reconcile cycle (HTTP `/api/v1/refresh`). */
  requestRefresh(): { queued: boolean; coalesced: boolean } {
    const coalesced = this.#pendingRefresh || this.#ticking;
    this.#pendingRefresh = true;
    if (!this.#ticking) this.#scheduleTick(0);
    return { queued: true, coalesced };
  }

  // -- the poll tick --------------------------------------------------------

  async tick(): Promise<void> {
    if (this.#stopped || this.#ticking) return;
    this.#ticking = true;
    this.#pendingRefresh = false;

    try {
      await this.reconcile();

      const validation = await this.validateDispatch();
      if (!validation.ok) {
        this.logger.error("dispatch preflight failed; skipping dispatch this tick", {
          category: validation.error.category,
          reason: validation.error.message,
        });
        return;
      }
      const config = validation.value;

      const candidates = await this.#tracker!.fetchIssuesByStates(config.tracker.active_states);
      if (!candidates.ok) {
        this.logger.warn("candidate fetch failed; skipping dispatch this tick", {
          category: candidates.error.category,
          reason: candidates.error.message,
        });
        return;
      }

      for (const issue of sortForDispatch(candidates.value)) {
        this.#urls.set(issue.id, issue.url);
        if (this.#availableSlots() <= 0) break;
        if (!this.#shouldDispatch(issue)) continue;
        this.dispatch(issue, null);
      }
    } finally {
      this.#ticking = false;
      const interval = this.#config?.polling.interval_ms ?? 30_000;
      this.#scheduleTick(this.#pendingRefresh ? 0 : interval);
    }
  }

  /** Spec 8.5: stall detection, then tracker state refresh. */
  async reconcile(): Promise<void> {
    const config = this.#config;
    if (!config || this.#running.size === 0) return;

    // Part A: stall detection.
    const stallTimeout = config.runner.stall_timeout_ms;
    if (stallTimeout > 0) {
      const now = this.#now();
      for (const [issueId, entry] of [...this.#running]) {
        const lastAt = entry.session.last_agent_timestamp
          ? Date.parse(entry.session.last_agent_timestamp)
          : entry.started_at_ms;
        if (now - lastAt > stallTimeout) {
          this.logger.warn("session stalled; terminating", {
            issue_id: issueId,
            issue_identifier: entry.identifier,
            session_id: entry.session.session_id ?? undefined,
            elapsed_ms: now - lastAt,
            stall_timeout_ms: stallTimeout,
          });
          entry.last_error = "stalled";
          await this.terminateRunning(issueId, false, "stalled");
        }
      }
    }

    // Part B: tracker state refresh.
    const runningIds = [...this.#running.keys()];
    if (runningIds.length === 0) return;

    const refreshed = await this.#tracker!.fetchIssuesByIds(runningIds);
    if (!refreshed.ok) {
      this.logger.debug("state refresh failed; keeping workers running", {
        reason: refreshed.error.message,
      });
      return;
    }

    const terminal = config.tracker.terminal_states.map(normalizeState);
    const active = config.tracker.active_states.map(normalizeState);
    const returned = new Set<string>();

    for (const issue of refreshed.value) {
      returned.add(issue.id);
      const entry = this.#running.get(issue.id);
      if (!entry) continue;
      const state = normalizeState(issue.state);
      this.#urls.set(issue.id, issue.url);

      if (terminal.includes(state)) {
        await this.terminateRunning(issue.id, true, `issue reached terminal state '${issue.state}'`);
      } else if (active.includes(state) && issueRoutable(issue, config.tracker.required_labels)) {
        entry.issue = issue;
      } else {
        await this.terminateRunning(issue.id, false, `issue left the active set (state '${issue.state}')`);
      }
    }

    for (const missing of runningIds.filter((id) => !returned.has(id))) {
      await this.terminateRunning(missing, false, "issue no longer visible in tracker scope");
    }
  }

  // -- dispatch and claims --------------------------------------------------

  #availableSlots(): number {
    const limit = this.#config?.agent.max_concurrent_agents ?? 0;
    return Math.max(limit - this.#running.size, 0);
  }

  #stateSlotsAvailable(issue: Issue): boolean {
    const config = this.#config!;
    const key = normalizeState(issue.state);
    const limit = config.agent.max_concurrent_agents_by_state[key] ?? config.agent.max_concurrent_agents;
    let used = 0;
    for (const entry of this.#running.values()) {
      if (normalizeState(entry.issue.state) === key) used += 1;
    }
    return used < limit;
  }

  #shouldDispatch(issue: Issue, ignoreClaim?: string): boolean {
    const config = this.#config!;
    if (!issue.id || !issue.identifier || !issue.title || !issue.state) return false;

    const state = normalizeState(issue.state);
    if (config.tracker.terminal_states.map(normalizeState).includes(state)) return false;
    if (!config.tracker.active_states.map(normalizeState).includes(state)) return false;
    if (!issueRoutable(issue, config.tracker.required_labels)) return false;
    if (this.#running.has(issue.id)) return false;
    if (this.#claimed.has(issue.id) && issue.id !== ignoreClaim) return false;
    if (this.#availableSlots() <= 0) return false;
    return this.#stateSlotsAvailable(issue);
  }

  dispatch(issue: Issue, attempt: number | null): void {
    const config = this.#config!;
    const adapter = this.agents.resolve(config.runner.kind);
    if (!adapter.ok) {
      this.#scheduleRetry(issue.id, issue.identifier, nextAttempt(attempt), adapter.error.message);
      return;
    }

    const controller = new AbortController();
    const entry: RunningEntry = {
      issue,
      identifier: issue.identifier,
      session: emptyLiveSession(config.runner.kind),
      started_at: new Date().toISOString(),
      started_at_ms: this.#now(),
      retry_attempt: attempt,
      workspace_path: null,
      last_error: null,
      recent_events: [],
      controller,
      done: Promise.resolve(),
    };
    // Sessions of an adapter that cannot report usage must never look like measured zeros.
    entry.session.usage_reported = adapter.value.capabilities(config.runner).usage_reporting;

    this.#running.set(issue.id, entry);
    this.#claimed.add(issue.id);
    const existingRetry = this.#retries.get(issue.id);
    if (existingRetry?.timer_handle) clearTimeout(existingRetry.timer_handle);
    this.#retries.delete(issue.id);

    const logger = this.logger.child({
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      agent_kind: config.runner.kind,
    });
    logger.info("dispatching issue", { attempt: attempt ?? 0, state: issue.state });

    entry.done = (async () => {
      let exit: { reason: "normal" | "error"; error?: string };
      try {
        exit = await runAgentAttempt({
          issue,
          attempt,
          config,
          workspaces: this.#workspaces!,
          tracker: this.#tracker!,
          adapter: adapter.value,
          logger,
          signal: controller.signal,
          onEvent: (event) => this.onAgentEvent(issue.id, event),
          onWorkspace: (path) => {
            const current = this.#running.get(issue.id);
            if (current) current.workspace_path = path;
          },
        });
      } catch (error) {
        exit = { reason: "error", error: error instanceof Error ? error.message : String(error) };
      }
      this.onWorkerExit(issue.id, exit);
    })();
  }

  // -- worker feedback ------------------------------------------------------

  /** Spec 13.5: accumulate usage by the mode the adapter declared. */
  onAgentEvent(issueId: string, event: AgentEvent): void {
    const entry = this.#running.get(issueId);
    if (!entry) return;

    entry.session.last_agent_event = event.event;
    entry.session.last_agent_timestamp = event.timestamp;
    if (event.message) entry.session.last_agent_message = event.message;
    if (event.agent_process_pid) entry.session.agent_process_pid = event.agent_process_pid;

    if (event.event === "session_started" && event.message) {
      entry.session.session_key = event.message;
      entry.session.session_id = `${event.message}-1`;
    }
    if (event.event === "turn_started") {
      entry.session.turn_count += 1;
      entry.session.turn_key = event.message ?? String(entry.session.turn_count);
      entry.session.session_id = `${entry.session.session_key ?? "session"}-${entry.session.turn_key}`;
    }

    if (event.usage) {
      entry.session.usage_reported = true;
      const { input_tokens, output_tokens, total_tokens, mode } = event.usage;
      if (mode === "cumulative") {
        const deltaIn = Math.max(0, input_tokens - entry.session.last_reported_input_tokens);
        const deltaOut = Math.max(0, output_tokens - entry.session.last_reported_output_tokens);
        const deltaTotal = Math.max(0, total_tokens - entry.session.last_reported_total_tokens);
        entry.session.last_reported_input_tokens = input_tokens;
        entry.session.last_reported_output_tokens = output_tokens;
        entry.session.last_reported_total_tokens = total_tokens;
        this.#addTokens(entry, deltaIn, deltaOut, deltaTotal);
      } else {
        this.#addTokens(entry, input_tokens, output_tokens, total_tokens);
      }
    }

    if (event.rate_limits !== undefined) this.#rateLimits = event.rate_limits;

    entry.recent_events.push({
      at: event.timestamp,
      event: event.event,
      message: event.message ?? "",
    });
    if (entry.recent_events.length > RECENT_EVENT_LIMIT) entry.recent_events.shift();
  }

  #addTokens(entry: RunningEntry, input: number, output: number, total: number): void {
    entry.session.agent_input_tokens += input;
    entry.session.agent_output_tokens += output;
    entry.session.agent_total_tokens += total;
    this.#totals.input_tokens += input;
    this.#totals.output_tokens += output;
    this.#totals.total_tokens += total;
  }

  onWorkerExit(issueId: string, exit: { reason: "normal" | "error"; error?: string }): void {
    const entry = this.#running.get(issueId);
    this.#running.delete(issueId);
    if (entry) {
      this.#totals.seconds_running += (this.#now() - entry.started_at_ms) / 1000;
    }
    const identifier = entry?.identifier ?? issueId;

    if (exit.reason === "normal") {
      this.#completed.add(issueId); // bookkeeping only; never gates dispatch
      this.logger.info("worker completed", { issue_id: issueId, issue_identifier: identifier });
      // A clean exit does not mean the issue is finished; re-check shortly (spec 7.1).
      this.#scheduleRetry(issueId, identifier, 1, null, CONTINUATION_DELAY_MS);
    } else {
      this.logger.warn("worker failed", {
        issue_id: issueId,
        issue_identifier: identifier,
        reason: exit.error ?? "unknown",
      });
      this.#scheduleRetry(issueId, identifier, nextAttempt(entry?.retry_attempt ?? null), exit.error ?? "worker failed");
    }
  }

  /** Terminate a running worker. `cleanup` removes the workspace (terminal issues only). */
  async terminateRunning(issueId: string, cleanup: boolean, reason: string): Promise<void> {
    const entry = this.#running.get(issueId);
    if (!entry) return;
    this.logger.info("terminating run", {
      issue_id: issueId,
      issue_identifier: entry.identifier,
      reason,
      cleanup_workspace: cleanup,
    });
    entry.controller.abort();
    // Bounded: a misbehaving adapter must not be able to wedge reconciliation.
    const settled = await Promise.race([
      entry.done.then(() => true).catch(() => true),
      Bun.sleep(10_000).then(() => false),
    ]);
    if (!settled) {
      this.logger.warn("worker did not stop within 10s; abandoning it", {
        issue_id: issueId,
        issue_identifier: entry.identifier,
      });
      this.#running.delete(issueId);
    }

    if (cleanup && this.#workspaces) {
      await this.#workspaces.remove(entry.identifier, {
        issue_id: issueId,
        issue_identifier: entry.identifier,
      });
      // A terminal issue must not be re-dispatched by the continuation retry the exit scheduled.
      this.#cancelRetry(issueId);
      this.#claimed.delete(issueId);
    }
  }

  // -- retries --------------------------------------------------------------

  #cancelRetry(issueId: string): void {
    const existing = this.#retries.get(issueId);
    if (existing?.timer_handle) clearTimeout(existing.timer_handle);
    this.#retries.delete(issueId);
  }

  #scheduleRetry(
    issueId: string,
    identifier: string,
    attempt: number,
    error: string | null,
    fixedDelayMs?: number,
  ): void {
    if (this.#stopped) return;
    this.#cancelRetry(issueId);

    const maxBackoff = this.#config?.agent.max_retry_backoff_ms ?? 300_000;
    const delay =
      fixedDelayMs ?? Math.min(FAILURE_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1), maxBackoff);

    this.#claimed.add(issueId);
    const timer = setTimeout(() => {
      void this.#onRetryTimer(issueId);
    }, delay);
    this.#retries.set(issueId, {
      issue_id: issueId,
      identifier,
      attempt,
      due_at_ms: this.#now() + delay,
      timer_handle: timer,
      error,
    });
    this.logger.debug("retry scheduled", {
      issue_id: issueId,
      issue_identifier: identifier,
      attempt,
      delay_ms: delay,
      reason: error ?? "continuation",
    });
  }

  async #onRetryTimer(issueId: string): Promise<void> {
    const entry = this.#retries.get(issueId);
    this.#retries.delete(issueId);
    if (!entry || this.#stopped || !this.#config || !this.#tracker) return;

    const refreshed = await this.#tracker.fetchIssuesByIds([issueId]);
    if (!refreshed.ok) {
      this.#scheduleRetry(issueId, entry.identifier, entry.attempt + 1, "retry refresh failed");
      return;
    }

    const issue = refreshed.value.find((i) => i.id === issueId);
    if (!issue) {
      this.#claimed.delete(issueId);
      return;
    }
    this.#urls.set(issue.id, issue.url);

    if (normalizeState(issue.state) && this.#config.tracker.terminal_states.map(normalizeState).includes(normalizeState(issue.state))) {
      await this.#workspaces?.remove(issue.identifier, {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
      });
      this.#claimed.delete(issueId);
      return;
    }

    if (!this.#shouldDispatchIgnoringSlots(issue)) {
      this.#claimed.delete(issueId);
      return;
    }
    if (this.#availableSlots() <= 0 || !this.#stateSlotsAvailable(issue)) {
      this.#scheduleRetry(issueId, issue.identifier, entry.attempt + 1, "no available orchestrator slots");
      return;
    }
    this.dispatch(issue, entry.attempt);
  }

  #shouldDispatchIgnoringSlots(issue: Issue): boolean {
    const config = this.#config!;
    const state = normalizeState(issue.state);
    if (!config.tracker.active_states.map(normalizeState).includes(state)) return false;
    if (config.tracker.terminal_states.map(normalizeState).includes(state)) return false;
    if (!issueRoutable(issue, config.tracker.required_labels)) return false;
    return !this.#running.has(issue.id);
  }

  // -- observability --------------------------------------------------------

  snapshot(): Snapshot {
    const now = this.#now();
    let activeSeconds = 0;
    for (const entry of this.#running.values()) activeSeconds += (now - entry.started_at_ms) / 1000;

    return {
      generated_at: new Date().toISOString(),
      agent_kind: this.#config?.runner.kind ?? "unconfigured",
      counts: { running: this.#running.size, retrying: this.#retries.size },
      running: [...this.#running.values()].map((entry) => ({
        issue_id: entry.issue.id,
        issue_identifier: entry.identifier,
        issue_url: entry.issue.url,
        state: entry.issue.state,
        agent_kind: entry.session.agent_kind,
        session_id: entry.session.session_id,
        turn_count: entry.session.turn_count,
        usage_reported: entry.session.usage_reported,
        last_event: entry.session.last_agent_event,
        last_message: entry.session.last_agent_message,
        started_at: entry.started_at,
        last_event_at: entry.session.last_agent_timestamp,
        tokens: {
          input_tokens: entry.session.agent_input_tokens,
          output_tokens: entry.session.agent_output_tokens,
          total_tokens: entry.session.agent_total_tokens,
        },
      })),
      retrying: [...this.#retries.values()].map((entry) => ({
        issue_id: entry.issue_id,
        issue_identifier: entry.identifier,
        issue_url: this.#urls.get(entry.issue_id) ?? null,
        attempt: entry.attempt,
        due_at: new Date(Date.now() + Math.max(0, entry.due_at_ms - now)).toISOString(),
        error: entry.error,
      })),
      agent_totals: {
        ...this.#totals,
        seconds_running: Number((this.#totals.seconds_running + activeSeconds).toFixed(1)),
      },
      rate_limits: this.#rateLimits,
      warnings: this.#config?.warnings ?? (this.#configError ? [this.#configError.message] : []),
    };
  }

  issueDetail(identifier: string): Record<string, unknown> | null {
    const running = [...this.#running.values()].find((e) => e.identifier === identifier);
    const retry = [...this.#retries.values()].find((e) => e.identifier === identifier);
    if (!running && !retry) return null;

    return {
      issue_identifier: identifier,
      issue_id: running?.issue.id ?? retry?.issue_id ?? null,
      status: running ? "running" : "retrying",
      agent_kind: this.#config?.runner.kind ?? null,
      workspace: { path: running?.workspace_path ?? null },
      attempts: { current_retry_attempt: running?.retry_attempt ?? retry?.attempt ?? null },
      running: running
        ? {
            session_id: running.session.session_id,
            turn_count: running.session.turn_count,
            usage_reported: running.session.usage_reported,
            state: running.issue.state,
            started_at: running.started_at,
            last_event: running.session.last_agent_event,
            last_message: running.session.last_agent_message,
            last_event_at: running.session.last_agent_timestamp,
            tokens: {
              input_tokens: running.session.agent_input_tokens,
              output_tokens: running.session.agent_output_tokens,
              total_tokens: running.session.agent_total_tokens,
            },
          }
        : null,
      retry: retry
        ? { attempt: retry.attempt, due_at: new Date(retry.due_at_ms).toISOString(), error: retry.error }
        : null,
      recent_events: running?.recent_events ?? [],
      last_error: running?.last_error ?? retry?.error ?? null,
    };
  }

  /** Test seam: inspect internal claim state without exposing the maps. */
  debugState() {
    return {
      running: [...this.#running.keys()],
      claimed: [...this.#claimed],
      retrying: [...this.#retries.values()].map((r) => ({ id: r.issue_id, attempt: r.attempt, error: r.error })),
      completed: [...this.#completed],
    };
  }
}

/** Spec 8.2 sort order: priority bucket 1..4, then oldest creation, then identifier. */
export function sortForDispatch(issues: Issue[]): Issue[] {
  const bucket = (issue: Issue) =>
    issue.priority !== null && issue.priority >= 1 && issue.priority <= 4 ? issue.priority : 5;
  return [...issues].sort((a, b) => {
    const byPriority = bucket(a) - bucket(b);
    if (byPriority !== 0) return byPriority;

    const aCreated = a.created_at ? Date.parse(a.created_at) : Number.POSITIVE_INFINITY;
    const bCreated = b.created_at ? Date.parse(b.created_at) : Number.POSITIVE_INFINITY;
    if (aCreated !== bCreated) return aCreated - bCreated;

    return a.identifier.localeCompare(b.identifier);
  });
}

function nextAttempt(attempt: number | null): number {
  return attempt === null ? 1 : attempt + 1;
}
