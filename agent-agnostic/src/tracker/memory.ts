/**
 * `memory` tracker adapter.
 *
 * Adapter profile (spec 11.2):
 * - `tracker.kind`: `memory`
 * - `tracker.provider.path`: OPTIONAL path to a JSON file holding `{ "issues": [...] }`. When set,
 *   the file is re-read on every fetch, so an operator can drive the orchestrator by editing it,
 *   and tool writes are persisted back. When omitted, issues live in process memory only.
 * - Scope: every issue in the file. Pagination: none, the file is read whole.
 * - `id` mapping: the record's `id`. `native_ref`: the record's `native_ref`, or null.
 * - `dispatchable`: taken verbatim from the record; defaults to `true` when absent, because a
 *   hand-written fixture that omits it means "yes".
 * - Tools: `set_issue_state` and `add_issue_comment`, both mutating.
 * - Errors: `tracker_response` for an unreadable or malformed file.
 *
 * It exists so the orchestrator can be exercised end to end — in tests, in a local smoke run, and
 * when bringing up a new agent adapter — without a network or a real tracker account.
 */

import { err, ok, type Result } from "../errors.ts";
import type { TrackerConfig } from "../config/schema.ts";
import type { Logger } from "../logging.ts";
import type { Issue } from "../types.ts";
import type { ToolResult, ToolSpec } from "../agent/types.ts";
import { normalizeIssue, type TrackerAdapter, type TrackerContext } from "./types.ts";

type Record_ = Parameters<typeof normalizeIssue>[0] & { comments?: unknown[] };

export class MemoryTracker implements TrackerAdapter {
  readonly kind = "memory";
  #records: Record_[];
  #path: string | null;

  constructor(options: { records?: Record_[]; path?: string | null; logger?: Logger }) {
    this.#records = options.records ?? [];
    this.#path = options.path ?? null;
  }

  async #load(): Promise<Result<Record_[]>> {
    if (!this.#path) return ok(this.#records);
    const file = Bun.file(this.#path);
    if (!(await file.exists())) {
      return err("tracker_response", `memory tracker file not found: ${this.#path}`);
    }
    try {
      const parsed = (await file.json()) as { issues?: unknown };
      if (!Array.isArray(parsed.issues)) {
        return err("tracker_response", "memory tracker file must contain an 'issues' array");
      }
      this.#records = parsed.issues as Record_[];
      return ok(this.#records);
    } catch (error) {
      return err(
        "tracker_response",
        `memory tracker file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async #save(): Promise<void> {
    if (!this.#path) return;
    await Bun.write(this.#path, `${JSON.stringify({ issues: this.#records }, null, 2)}\n`);
  }

  #normalize(record: Record_): { ok: true; issue: Issue } | { ok: false; reason: string } {
    return normalizeIssue({ dispatchable: true, ...record });
  }

  async fetchIssuesByStates(states: string[]): Promise<Result<Issue[]>> {
    if (states.length === 0) return ok([]); // spec 11.1: no provider request
    const loaded = await this.#load();
    if (!loaded.ok) return loaded;

    const wanted = new Set(states.map((s) => s.trim().toLowerCase()));
    const issues: Issue[] = [];
    for (const record of loaded.value) {
      const normalized = this.#normalize(record);
      // A state-list read MAY omit an individually malformed record (spec 11.1).
      if (!normalized.ok) continue;
      if (wanted.has(normalized.issue.state.trim().toLowerCase())) issues.push(normalized.issue);
    }
    return ok(issues);
  }

  async fetchIssuesByIds(ids: string[]): Promise<Result<Issue[]>> {
    if (ids.length === 0) return ok([]);
    const loaded = await this.#load();
    if (!loaded.ok) return loaded;

    const wanted = new Set(ids);
    const issues: Issue[] = [];
    for (const record of loaded.value) {
      if (typeof record.id !== "string" || !wanted.has(record.id)) continue;
      const normalized = this.#normalize(record);
      // An ID refresh MUST fail rather than silently omit a malformed requested record, because
      // omission means "no longer visible" to the scheduler (spec 11.1).
      if (!normalized.ok) {
        return err("tracker_response", `issue ${record.id} is malformed: ${normalized.reason}`);
      }
      issues.push(normalized.issue);
    }
    return ok(issues);
  }

  agentToolSpecs(): ToolSpec[] {
    return [
      {
        name: "set_issue_state",
        description: "Move the current issue to a new state.",
        input_schema: {
          type: "object",
          properties: { state: { type: "string", description: "Target state name" } },
          required: ["state"],
        },
      },
      {
        name: "add_issue_comment",
        description: "Append a comment to the current issue.",
        input_schema: {
          type: "object",
          properties: { body: { type: "string", description: "Comment text" } },
          required: ["body"],
        },
      },
    ];
  }

  async executeAgentTool(
    name: string,
    args: Record<string, unknown>,
    context: TrackerContext,
  ): Promise<ToolResult> {
    const loaded = await this.#load();
    if (!loaded.ok) return { success: false, error: loaded.error.message };

    const record = loaded.value.find((r) => r.id === context.issue.id);
    if (!record) return { success: false, error: `issue ${context.issue.id} not found` };

    switch (name) {
      case "set_issue_state": {
        if (typeof args.state !== "string" || args.state.trim().length === 0) {
          return { success: false, error: "state must be a non-empty string" };
        }
        record.state = args.state;
        await this.#save();
        return { success: true, output: { id: record.id, state: record.state } };
      }
      case "add_issue_comment": {
        if (typeof args.body !== "string" || args.body.trim().length === 0) {
          return { success: false, error: "body must be a non-empty string" };
        }
        record.comments = [
          ...((record.comments as unknown[]) ?? []),
          { at: new Date().toISOString(), body: args.body },
        ];
        await this.#save();
        return { success: true, output: { id: record.id, comments: (record.comments as unknown[]).length } };
      }
      default:
        return { success: false, error: `unsupported tool '${name}'` };
    }
  }

  secretEnvironmentNames(): string[] {
    return [];
  }
}

export function createMemoryTracker(options: {
  config: TrackerConfig;
  logger: Logger;
}): Result<TrackerAdapter> {
  const path = options.config.provider.path;
  if (path !== undefined && typeof path !== "string") {
    return err("invalid_tracker_config", "tracker.provider.path must be a string");
  }
  const records = options.config.provider.issues;
  if (records !== undefined && !Array.isArray(records)) {
    return err("invalid_tracker_config", "tracker.provider.issues must be a list");
  }
  return ok(
    new MemoryTracker({
      path: (path as string | undefined) ?? null,
      records: (records as Record_[] | undefined) ?? [],
      logger: options.logger,
    }),
  );
}
