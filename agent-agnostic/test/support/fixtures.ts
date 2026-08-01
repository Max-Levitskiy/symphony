/** Shared fixtures: temp workspaces, workflow files, and issue records. */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "../../src/logging.ts";
import type { Issue } from "../../src/types.ts";

export async function tempDir(prefix = "symphony-test-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function cleanup(...paths: string[]): Promise<void> {
  await Promise.all(paths.map((p) => rm(p, { recursive: true, force: true })));
}

/** A logger that swallows output so test runs stay readable. */
export const quietLogger = () => new Logger({ level: "error" });

export function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    native_ref: null,
    identifier: "AA-1",
    title: "Do the thing",
    description: "A description",
    priority: 2,
    state: "Todo",
    branch_name: null,
    url: "https://tracker.example/AA-1",
    assignee_id: null,
    labels: [],
    blocked_by: [],
    dispatchable: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export type WorkflowFixture = {
  path: string;
  dir: string;
  workspaceRoot: string;
  trackerPath: string;
  dispose: () => Promise<void>;
};

/**
 * Write a runnable WORKFLOW.md backed by the `memory` tracker, plus its issue file.
 * `frontMatterExtra` is spliced in verbatim so tests can vary the `runner` block.
 */
export async function workflowFixture(options: {
  issues: Partial<Issue>[];
  runnerBlock?: string;
  prompt?: string;
  activeStates?: string[];
  terminalStates?: string[];
  requiredLabels?: string[];
  extra?: string;
}): Promise<WorkflowFixture> {
  const dir = await tempDir();
  const workspaceRoot = join(dir, "workspaces");
  const trackerPath = join(dir, "issues.json");
  const path = join(dir, "WORKFLOW.md");

  await Bun.write(
    trackerPath,
    `${JSON.stringify({ issues: options.issues.map((i) => issue(i)) }, null, 2)}\n`,
  );

  const runner = options.runnerBlock ?? "runner:\n  kind: mock\n";
  const front = [
    "---",
    "tracker:",
    "  kind: memory",
    "  provider:",
    `    path: ${JSON.stringify(trackerPath)}`,
    "  active_states:",
    ...(options.activeStates ?? ["Todo", "In Progress"]).map((s) => `    - ${JSON.stringify(s)}`),
    "  terminal_states:",
    ...(options.terminalStates ?? ["Done", "Cancelled"]).map((s) => `    - ${JSON.stringify(s)}`),
    ...(options.requiredLabels
      ? ["  required_labels:", ...options.requiredLabels.map((l) => `    - ${JSON.stringify(l)}`)]
      : []),
    "polling:",
    "  interval_ms: 3600000",
    "workspace:",
    `  root: ${JSON.stringify(workspaceRoot)}`,
    "agent:",
    "  max_concurrent_agents: 4",
    "  max_turns: 3",
    runner.trimEnd(),
    ...(options.extra ? [options.extra.trimEnd()] : []),
    "---",
    "",
    options.prompt ?? "Work on {{ issue.identifier }}: {{ issue.title }}",
    "",
  ].join("\n");

  await Bun.write(path, front);
  return { path, dir, workspaceRoot, trackerPath, dispose: () => cleanup(dir) };
}
