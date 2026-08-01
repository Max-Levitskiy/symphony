/** Dispatch, reconciliation, retry, and observability (forked spec 17.4, 17.6). */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import { Orchestrator, sortForDispatch } from "../src/orchestrator/orchestrator.ts";
import { AgentRegistry } from "../src/agent/registry.ts";
import { defaultTrackerRegistry } from "../src/tracker/registry.ts";
import { mockAdapter, type MockScript } from "./support/mock-adapter.ts";
import { cleanup, issue, quietLogger, workflowFixture, type WorkflowFixture } from "./support/fixtures.ts";
import type { Issue } from "../src/types.ts";

const fixtures: WorkflowFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.dispose()));
});

async function orchestratorFor(options: {
  issues: Partial<Issue>[];
  script?: MockScript;
  runnerBlock?: string;
  requiredLabels?: string[];
}) {
  const fixture = await workflowFixture({
    issues: options.issues,
    runnerBlock: options.runnerBlock,
    requiredLabels: options.requiredLabels,
  });
  fixtures.push(fixture);
  const { adapter, record } = mockAdapter(options.script ?? {});
  const orchestrator = new Orchestrator({
    workflowPath: fixture.path,
    logger: quietLogger(),
    agents: new AgentRegistry().register(adapter),
    trackers: defaultTrackerRegistry(),
  });
  return { fixture, orchestrator, record, adapter };
}

/** Wait until `check` is true, or fail after `timeoutMs`. */
async function until(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function setIssueState(fixture: WorkflowFixture, id: string, state: string): Promise<void> {
  const data = (await Bun.file(fixture.trackerPath).json()) as { issues: Issue[] };
  for (const record of data.issues) if (record.id === id) record.state = state;
  await Bun.write(fixture.trackerPath, JSON.stringify(data, null, 2));
}

describe("dispatch ordering", () => {
  test("priority bucket first, then oldest, then identifier", () => {
    const sorted = sortForDispatch([
      issue({ identifier: "D", priority: null, created_at: "2026-01-01T00:00:00Z" }),
      issue({ identifier: "B", priority: 1, created_at: "2026-01-03T00:00:00Z" }),
      issue({ identifier: "A", priority: 1, created_at: "2026-01-02T00:00:00Z" }),
      issue({ identifier: "C", priority: 9, created_at: "2026-01-01T00:00:00Z" }),
    ]);
    expect(sorted.map((i) => i.identifier)).toEqual(["A", "B", "C", "D"]);
  });
});

describe("candidate eligibility", () => {
  test("dispatchable=false issues never run", async () => {
    const { orchestrator, record } = await orchestratorFor({
      issues: [{ id: "a", identifier: "AA-1", dispatchable: false }],
    });
    await orchestrator.start();
    await Bun.sleep(150);
    await orchestrator.stop();
    expect(record.sessions).toBe(0);
  });

  test("required labels are matched case-insensitively after normalization", async () => {
    const { orchestrator, record } = await orchestratorFor({
      issues: [
        { id: "a", identifier: "AA-1", labels: ["Ready"] },
        { id: "b", identifier: "AA-2", labels: ["other"] },
      ],
      requiredLabels: ["  READY "],
      script: { turnDelayMs: 400 },
    });
    await orchestrator.start();
    await until(() => record.sessions > 0, 2000, "labelled issue dispatch");
    expect(orchestrator.debugState().running).toEqual(["a"]);
    await orchestrator.stop();
    expect(record.sessions).toBe(1);
  });

  test("global concurrency caps simultaneous runs", async () => {
    const { orchestrator, record } = await orchestratorFor({
      issues: [1, 2, 3, 4, 5, 6].map((n) => ({ id: `i${n}`, identifier: `AA-${n}` })),
      script: { turnDelayMs: 400 },
    });
    await orchestrator.start();
    await until(() => orchestrator.debugState().running.length > 0, 2000, "first dispatch");
    expect(orchestrator.debugState().running.length).toBeLessThanOrEqual(4); // max_concurrent_agents
    await orchestrator.stop();
    expect(record.sessions).toBeLessThanOrEqual(4);
  });
});

describe("reconciliation", () => {
  test("a terminal transition stops the run and removes the workspace", async () => {
    const { orchestrator, fixture } = await orchestratorFor({
      issues: [{ id: "a", identifier: "AA-1" }],
      script: { turnDelayMs: 300 },
    });
    await orchestrator.start();
    await until(() => orchestrator.debugState().running.includes("a"), 2000, "run start");
    const workspace = join(fixture.workspaceRoot, "AA-1");
    await until(() => stat(workspace).then(() => true, () => false), 2000, "workspace creation");
    expect((await stat(workspace)).isDirectory()).toBe(true);

    await setIssueState(fixture, "a", "Done");
    await orchestrator.reconcile();

    expect(orchestrator.debugState().running).not.toContain("a");
    await expect(stat(workspace)).rejects.toThrow();
    await orchestrator.stop();
  });

  test("leaving the active set stops the run but keeps the workspace", async () => {
    const { orchestrator, fixture } = await orchestratorFor({
      issues: [{ id: "a", identifier: "AA-1" }],
      script: { turnDelayMs: 300 },
    });
    await orchestrator.start();
    await until(() => orchestrator.debugState().running.includes("a"), 2000, "run start");

    await setIssueState(fixture, "a", "Backlog"); // neither active nor terminal
    await orchestrator.reconcile();

    expect(orchestrator.debugState().running).not.toContain("a");
    expect((await stat(join(fixture.workspaceRoot, "AA-1"))).isDirectory()).toBe(true);
    await orchestrator.stop();
  });

  test("reconciliation with nothing running is a no-op", async () => {
    const { orchestrator } = await orchestratorFor({ issues: [] });
    await orchestrator.reload();
    await orchestrator.reconcile();
    expect(orchestrator.debugState().running).toEqual([]);
  });

  test("a stalled session is terminated and requeued", async () => {
    const { orchestrator } = await orchestratorFor({
      issues: [{ id: "a", identifier: "AA-1" }],
      script: { turnDelayMs: 5_000, capabilities: { streaming_events: false } },
      runnerBlock: "runner:\n  kind: mock\n  stall_timeout_ms: 50\n",
    });
    await orchestrator.start();
    await until(() => orchestrator.debugState().running.includes("a"), 2000, "run start");
    await Bun.sleep(120);
    await orchestrator.reconcile();
    expect(orchestrator.debugState().running).not.toContain("a");
    await orchestrator.stop();
  });
});

describe("retries", () => {
  test("a clean exit schedules a short continuation retry", async () => {
    const { orchestrator } = await orchestratorFor({ issues: [{ id: "a", identifier: "AA-1" }] });
    await orchestrator.start();
    await until(
      () => orchestrator.debugState().retrying.some((r) => r.id === "a"),
      3000,
      "continuation retry",
    );
    const retry = orchestrator.debugState().retrying.find((r) => r.id === "a")!;
    expect(retry.attempt).toBe(1);
    expect(retry.error).toBeNull();
    await orchestrator.stop();
  });

  test("a failed attempt schedules a backoff retry carrying the reason", async () => {
    const { orchestrator } = await orchestratorFor({
      issues: [{ id: "a", identifier: "AA-1" }],
      script: { statuses: ["failed"] },
    });
    await orchestrator.start();
    await until(
      () => orchestrator.debugState().retrying.some((r) => r.id === "a" && r.error !== null),
      3000,
      "failure retry",
    );
    const retry = orchestrator.debugState().retrying.find((r) => r.id === "a")!;
    expect(retry.error).toContain("failed");
    await orchestrator.stop();
  });
});

describe("token accounting", () => {
  test("cumulative reports are de-duplicated; incremental reports add up", async () => {
    const cumulative = await orchestratorFor({
      issues: [{ id: "a", identifier: "AA-1" }],
      script: {
        usage: [
          { input: 100, output: 50, total: 150, mode: "cumulative" },
          { input: 180, output: 70, total: 250, mode: "cumulative" },
          { input: 180, output: 70, total: 250, mode: "cumulative" },
        ],
      },
    });
    await cumulative.orchestrator.start();
    await until(
      () => cumulative.orchestrator.snapshot().agent_totals.total_tokens >= 250,
      3000,
      "cumulative totals",
    );
    expect(cumulative.orchestrator.snapshot().agent_totals.total_tokens).toBe(250);
    await cumulative.orchestrator.stop();

    const incremental = await orchestratorFor({
      issues: [{ id: "a", identifier: "AA-1" }],
      script: {
        usage: [
          { input: 10, output: 5, total: 15, mode: "incremental" },
          { input: 10, output: 5, total: 15, mode: "incremental" },
          { input: 10, output: 5, total: 15, mode: "incremental" },
        ],
      },
    });
    await incremental.orchestrator.start();
    await until(
      () => incremental.orchestrator.snapshot().agent_totals.total_tokens >= 45,
      3000,
      "incremental totals",
    );
    expect(incremental.orchestrator.snapshot().agent_totals.total_tokens).toBe(45);
    await incremental.orchestrator.stop();
  });

  test("an adapter that cannot report usage reports usage_reported=false, not zero usage", async () => {
    const { orchestrator } = await orchestratorFor({
      issues: [{ id: "a", identifier: "AA-1" }],
      script: { capabilities: { usage_reporting: false }, turnDelayMs: 300 },
    });
    await orchestrator.start();
    await until(() => orchestrator.snapshot().running.length > 0, 2000, "running row");
    const row = orchestrator.snapshot().running[0]!;
    expect(row.usage_reported).toBe(false);
    expect(row.tokens.total_tokens).toBe(0);
    await orchestrator.stop();
  });
});

describe("preflight", () => {
  test("an unregistered runner.kind fails startup", async () => {
    const fixture = await workflowFixture({
      issues: [{ id: "a", identifier: "AA-1" }],
      runnerBlock: "runner:\n  kind: nonexistent\n",
    });
    fixtures.push(fixture);
    const orchestrator = new Orchestrator({
      workflowPath: fixture.path,
      logger: quietLogger(),
      agents: new AgentRegistry(),
      trackers: defaultTrackerRegistry(),
    });
    const started = await orchestrator.start();
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.error.category).toBe("unsupported_agent_kind");
  });

  test("require_client_tools fails against an adapter that cannot call tools", async () => {
    const { orchestrator } = await orchestratorFor({
      issues: [],
      script: { capabilities: { client_tools: false } },
      runnerBlock: "runner:\n  kind: mock\n  require_client_tools: true\n",
    });
    const started = await orchestrator.start();
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.error.category).toBe("agent_capability_unsupported");
  });

  test("startup cleanup removes workspaces for already-terminal issues", async () => {
    const fixture = await workflowFixture({
      issues: [{ id: "a", identifier: "AA-1", state: "Done" }],
    });
    fixtures.push(fixture);
    const workspace = join(fixture.workspaceRoot, "AA-1");
    await Bun.write(join(workspace, "stale.txt"), "left over");

    const { adapter } = mockAdapter();
    const orchestrator = new Orchestrator({
      workflowPath: fixture.path,
      logger: quietLogger(),
      agents: new AgentRegistry().register(adapter),
      trackers: defaultTrackerRegistry(),
    });
    await orchestrator.start();
    await expect(stat(workspace)).rejects.toThrow();
    await orchestrator.stop();
  });
});
