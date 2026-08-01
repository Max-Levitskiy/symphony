/**
 * `github` tracker adapter.
 *
 * Adapter profile (spec 11.2):
 *
 * - `tracker.kind`: `github`
 * - `tracker.provider`:
 *   - `repository` (REQUIRED, `owner/name`)
 *   - `token` (REQUIRED, supports `$VAR`; falls back to `$GITHUB_TOKEN` when omitted)
 *   - `api_url` (default `https://api.github.com`)
 *   - `state_label_prefix` (default `status:`) — GitHub issues have only open/closed, so workflow
 *     states are carried on labels: `status:in progress` normalizes to the state `In Progress`.
 *   - `default_open_state` (default `Todo`) — the state for an open issue with no status label.
 *   - `closed_state` (default `Done`) — the state reported for a closed issue.
 *   - `require_assignee` (default `false`) — when true, an unassigned issue is `dispatchable=false`.
 * - Scope: one repository's issues. Pull requests are excluded. Pagination: `per_page=100` with
 *   `Link` header traversal, order preserved across pages.
 * - `id`: the issue node id (`node_id`), which is stable across renumbering.
 *   `native_ref`: `{ repository, number, node_id }` — non-secret, enough for provider-native tools.
 * - `dispatchable`: open, not a pull request, and assigned when `require_assignee` is set.
 * - Malformed records: a state-list read logs and omits them; an ID refresh fails.
 * - Errors: `missing_tracker_secret`, `invalid_tracker_config`, `tracker_request` (transport),
 *   `tracker_status` (non-2xx), `tracker_rate_limited` (403/429 with a rate-limit header),
 *   `tracker_response` (unparseable body), `tracker_pagination` (unusable Link header).
 * - Tools: `set_issue_state` (mutating; adds/removes status labels and opens/closes the issue) and
 *   `add_issue_comment` (mutating). Both act only on the issue in context.
 * - Secret env names: `GITHUB_TOKEN`, removed from the agent child environment.
 */

import { err, ok, type Result } from "../errors.ts";
import type { TrackerConfig } from "../config/schema.ts";
import type { Logger } from "../logging.ts";
import type { Issue } from "../types.ts";
import type { ToolResult, ToolSpec } from "../agent/types.ts";
import { normalizeIssue, type TrackerAdapter, type TrackerContext } from "./types.ts";

type Settings = {
  repository: string;
  token: string;
  apiUrl: string;
  statePrefix: string;
  defaultOpenState: string;
  closedState: string;
  requireAssignee: boolean;
};

type GhIssue = {
  node_id?: string;
  number?: number;
  title?: string;
  body?: string | null;
  state?: string;
  html_url?: string;
  pull_request?: unknown;
  assignee?: { id?: number; login?: string } | null;
  labels?: ({ name?: string } | string)[];
  created_at?: string;
  updated_at?: string;
};

export class GitHubTracker implements TrackerAdapter {
  readonly kind = "github";

  constructor(
    private readonly settings: Settings,
    private readonly logger: Logger,
  ) {}

  // -- HTTP ----------------------------------------------------------------

  async #request(path: string, init: RequestInit = {}): Promise<Result<{ body: unknown; link: string | null }>> {
    const url = path.startsWith("http") ? path : `${this.settings.apiUrl}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.settings.token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "symphony-agent-agnostic",
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(init.headers ?? {}),
        },
      });
    } catch (error) {
      return err("tracker_request", `github request failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (response.status === 403 || response.status === 429) {
      const remaining = response.headers.get("x-ratelimit-remaining");
      if (remaining === "0" || response.headers.has("retry-after")) {
        return err("tracker_rate_limited", `github rate limited (status ${response.status})`);
      }
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return err("tracker_status", `github returned ${response.status}: ${text.slice(0, 300)}`);
    }

    try {
      return ok({ body: await response.json(), link: response.headers.get("link") });
    } catch (error) {
      return err("tracker_response", `github response was not JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async #paginate(firstPath: string): Promise<Result<GhIssue[]>> {
    const collected: GhIssue[] = [];
    let next: string | null = firstPath;
    let guard = 0;

    while (next) {
      if (++guard > 100) return err("tracker_pagination", "github pagination exceeded 100 pages");
      const page: Result<{ body: unknown; link: string | null }> = await this.#request(next);
      if (!page.ok) return page;
      if (!Array.isArray(page.value.body)) {
        return err("tracker_response", "github issue list response was not an array");
      }
      collected.push(...(page.value.body as GhIssue[]));
      next = parseNextLink(page.value.link);
    }
    return ok(collected);
  }

  // -- normalization -------------------------------------------------------

  #stateOf(raw: GhIssue): string {
    if (raw.state === "closed") return this.settings.closedState;
    const prefix = this.settings.statePrefix.toLowerCase();
    for (const label of raw.labels ?? []) {
      const name = typeof label === "string" ? label : (label.name ?? "");
      if (name.toLowerCase().startsWith(prefix)) {
        return name.slice(this.settings.statePrefix.length).trim() || this.settings.defaultOpenState;
      }
    }
    return this.settings.defaultOpenState;
  }

  #normalize(raw: GhIssue) {
    const prefix = this.settings.statePrefix.toLowerCase();
    const labels = (raw.labels ?? [])
      .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
      .filter((name) => name.length > 0 && !name.toLowerCase().startsWith(prefix));

    const isPullRequest = raw.pull_request !== undefined && raw.pull_request !== null;
    const assigneeId = raw.assignee?.id !== undefined ? String(raw.assignee.id) : null;

    return normalizeIssue({
      id: raw.node_id,
      native_ref:
        raw.number !== undefined
          ? { repository: this.settings.repository, number: raw.number, node_id: raw.node_id ?? null }
          : null,
      identifier: raw.number !== undefined ? `${this.settings.repository}#${raw.number}` : undefined,
      title: raw.title,
      description: raw.body ?? null,
      priority: null,
      state: this.#stateOf(raw),
      url: raw.html_url ?? null,
      assignee_id: assigneeId,
      labels,
      blocked_by: [],
      dispatchable:
        !isPullRequest && raw.state === "open" && (!this.settings.requireAssignee || assigneeId !== null),
      created_at: raw.created_at ?? null,
      updated_at: raw.updated_at ?? null,
    });
  }

  // -- required operations -------------------------------------------------

  async fetchIssuesByStates(states: string[]): Promise<Result<Issue[]>> {
    if (states.length === 0) return ok([]);

    const wanted = new Set(states.map((s) => s.trim().toLowerCase()));
    // Closed issues are only relevant when a terminal state is requested; that keeps the common
    // active-state poll to a single cheap `state=open` listing.
    const needsClosed = wanted.has(this.settings.closedState.trim().toLowerCase());
    const scope = needsClosed ? "all" : "open";
    const raw = await this.#paginate(
      `/repos/${this.settings.repository}/issues?state=${scope}&per_page=100&sort=created&direction=asc`,
    );
    if (!raw.ok) return raw;

    const issues: Issue[] = [];
    for (const record of raw.value) {
      if (record.pull_request) continue;
      const normalized = this.#normalize(record);
      if (!normalized.ok) {
        this.logger.warn("omitted malformed github issue", { reason: normalized.reason, number: record.number });
        continue;
      }
      if (wanted.has(normalized.issue.state.trim().toLowerCase())) issues.push(normalized.issue);
    }
    return ok(issues);
  }

  async fetchIssuesByIds(ids: string[]): Promise<Result<Issue[]>> {
    if (ids.length === 0) return ok([]);

    // The REST list endpoint cannot filter by node id, so refresh reads the full current listing
    // once and selects. That keeps refresh atomic from the scheduler's perspective.
    const raw = await this.#paginate(`/repos/${this.settings.repository}/issues?state=all&per_page=100`);
    if (!raw.ok) return raw;

    const wanted = new Set(ids);
    const issues: Issue[] = [];
    for (const record of raw.value) {
      if (!record.node_id || !wanted.has(record.node_id)) continue;
      const normalized = this.#normalize(record);
      if (!normalized.ok) {
        return err("tracker_response", `github issue ${record.node_id} is malformed: ${normalized.reason}`);
      }
      issues.push(normalized.issue);
    }
    return ok(issues);
  }

  // -- provider-native agent tools ------------------------------------------

  agentToolSpecs(): ToolSpec[] {
    return [
      {
        name: "set_issue_state",
        description:
          "Move the current GitHub issue to a workflow state. Adds the matching status label, " +
          "removes other status labels, and opens or closes the issue as needed.",
        input_schema: {
          type: "object",
          properties: { state: { type: "string", description: "Target workflow state name" } },
          required: ["state"],
        },
      },
      {
        name: "add_issue_comment",
        description: "Add a comment to the current GitHub issue.",
        input_schema: {
          type: "object",
          properties: { body: { type: "string", description: "Comment body in GitHub Markdown" } },
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
    const number = (context.issue.native_ref as { number?: number } | null)?.number;
    if (typeof number !== "number") {
      return { success: false, error: "issue is missing its GitHub number in native_ref" };
    }
    const base = `/repos/${this.settings.repository}/issues/${number}`;

    if (name === "add_issue_comment") {
      if (typeof args.body !== "string" || args.body.trim().length === 0) {
        return { success: false, error: "body must be a non-empty string" };
      }
      const result = await this.#request(`${base}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: args.body }),
      });
      return result.ok
        ? { success: true, output: { commented: true, issue: number } }
        : { success: false, error: result.error.message };
    }

    if (name === "set_issue_state") {
      if (typeof args.state !== "string" || args.state.trim().length === 0) {
        return { success: false, error: "state must be a non-empty string" };
      }
      const target = args.state.trim();
      const current = await this.#request(base);
      if (!current.ok) return { success: false, error: current.error.message };

      const existing = ((current.value.body as GhIssue).labels ?? []).map((l) =>
        typeof l === "string" ? l : (l.name ?? ""),
      );
      const prefix = this.settings.statePrefix.toLowerCase();
      const keep = existing.filter((l) => !l.toLowerCase().startsWith(prefix));
      const closing = target.trim().toLowerCase() === this.settings.closedState.trim().toLowerCase();
      const labels = closing ? keep : [...keep, `${this.settings.statePrefix}${target}`];

      const updated = await this.#request(base, {
        method: "PATCH",
        body: JSON.stringify({ labels, state: closing ? "closed" : "open" }),
      });
      return updated.ok
        ? { success: true, output: { issue: number, state: target } }
        : { success: false, error: updated.error.message };
    }

    return { success: false, error: `unsupported tool '${name}'` };
  }

  secretEnvironmentNames(): string[] {
    return ["GITHUB_TOKEN"];
  }
}

function parseNextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (match) return match[1]!;
  }
  return null;
}

export function createGitHubTracker(options: {
  config: TrackerConfig;
  logger: Logger;
  env?: Record<string, string | undefined>;
}): Result<TrackerAdapter> {
  const provider = options.config.provider;
  const env = options.env ?? process.env;

  const repository = provider.repository;
  if (typeof repository !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    return err("invalid_tracker_config", "tracker.provider.repository must be 'owner/name'");
  }
  const token = typeof provider.token === "string" && provider.token.length > 0 ? provider.token : env.GITHUB_TOKEN;
  if (!token) {
    return err(
      "missing_tracker_secret",
      "tracker.provider.token is empty and $GITHUB_TOKEN is not set",
    );
  }

  const stringOr = (value: unknown, fallback: string) =>
    typeof value === "string" && value.length > 0 ? value : fallback;

  return ok(
    new GitHubTracker(
      {
        repository,
        token,
        apiUrl: stringOr(provider.api_url, "https://api.github.com").replace(/\/$/, ""),
        statePrefix: stringOr(provider.state_label_prefix, "status:"),
        defaultOpenState: stringOr(provider.default_open_state, "Todo"),
        closedState: stringOr(provider.closed_state, "Done"),
        requireAssignee: provider.require_assignee === true,
      },
      options.logger,
    ),
  );
}
