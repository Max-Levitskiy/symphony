/**
 * End-to-end runs with real adapters and a real subprocess (forked spec 17.5, 17.7, 13.7).
 *
 * The `cli-exec` case is the proof of the fork's claim in executable form: a shell command with no
 * session model, no protocol, and no telemetry is orchestrated to completion by the same code path
 * that drives a full-capability agent.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Orchestrator } from "../src/orchestrator/orchestrator.ts";
import { defaultAgentRegistry } from "../src/agent/registry.ts";
import { defaultTrackerRegistry } from "../src/tracker/registry.ts";
import { startHttpServer } from "../src/http/server.ts";
import { parseArgs } from "../src/cli.ts";
import { cleanup, quietLogger, workflowFixture, type WorkflowFixture } from "./support/fixtures.ts";
import type { Issue } from "../src/types.ts";

const fixtures: WorkflowFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.dispose()));
});

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5000, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("cli-exec end to end", () => {
  test("a plain shell command is driven to completion, turn by turn", async () => {
    const fixture = await workflowFixture({
      issues: [{ id: "a", identifier: "AA-1", state: "Todo" }],
      runnerBlock: [
        "runner:",
        "  kind: cli-exec",
        '  command: "cat >> transcript.txt && echo done"',
        "  stall_timeout_ms: 0",
        "  provider:",
        "    prompt_delivery: stdin",
      ].join("\n"),
      prompt: "TASK {{ issue.identifier }}",
    });
    fixtures.push(fixture);

    const orchestrator = new Orchestrator({
      workflowPath: fixture.path,
      logger: quietLogger(),
      agents: defaultAgentRegistry(),
      trackers: defaultTrackerRegistry(),
    });

    const started = await orchestrator.start();
    expect(started.ok).toBe(true);

    const transcript = join(fixture.workspaceRoot, "AA-1", "transcript.txt");
    await until(() => Bun.file(transcript).exists(), 5000, "agent output");
    // max_turns is 3 and the issue stays active, so the worker runs all three turns.
    await until(
      async () => (await Bun.file(transcript).text()).split("TASK AA-1").length - 1 >= 3,
      5000,
      "three turns",
    );
    await orchestrator.stop();

    const text = await Bun.file(transcript).text();
    // A stateless adapter resends the whole task every turn, plus continuation guidance after
    // the first (spec 7.1, delta D-008).
    expect(text.split("TASK AA-1").length - 1).toBe(3);
    expect(text).toContain("Continue the work");
  }, 20_000);

  test("a failing command becomes a failed attempt with a retry queued", async () => {
    const fixture = await workflowFixture({
      issues: [{ id: "a", identifier: "AA-1" }],
      runnerBlock: ["runner:", "  kind: cli-exec", '  command: "exit 7"', "  stall_timeout_ms: 0"].join("\n"),
    });
    fixtures.push(fixture);

    const orchestrator = new Orchestrator({
      workflowPath: fixture.path,
      logger: quietLogger(),
      agents: defaultAgentRegistry(),
      trackers: defaultTrackerRegistry(),
    });
    await orchestrator.start();
    await until(
      () => orchestrator.debugState().retrying.some((r) => r.error?.includes("exit 7")),
      5000,
      "failure retry",
    );
    await orchestrator.stop();
  }, 20_000);
});

describe("http observability extension", () => {
  test("state, issue detail, refresh, and error semantics", async () => {
    const fixture = await workflowFixture({
      issues: [{ id: "a", identifier: "AA-1" }],
      runnerBlock: [
        "runner:",
        "  kind: cli-exec",
        '  command: "sleep 1"',
        "  stall_timeout_ms: 0",
      ].join("\n"),
    });
    fixtures.push(fixture);

    const orchestrator = new Orchestrator({
      workflowPath: fixture.path,
      logger: quietLogger(),
      agents: defaultAgentRegistry(),
      trackers: defaultTrackerRegistry(),
    });
    await orchestrator.start();
    const server = startHttpServer(orchestrator, 0);
    const base = `http://127.0.0.1:${server.port}`;

    try {
      await until(() => orchestrator.debugState().running.length > 0, 5000, "a running session");

      const state = (await (await fetch(`${base}/api/v1/state`)).json()) as Record<string, unknown>;
      expect(state.agent_kind).toBe("cli-exec");
      expect((state.running as unknown[]).length).toBe(1);
      expect((state.running as { usage_reported: boolean }[])[0]!.usage_reported).toBe(false);
      expect(state.agent_totals).toMatchObject({ total_tokens: 0 });

      const detail = (await (await fetch(`${base}/api/v1/AA-1`)).json()) as Record<string, unknown>;
      expect(detail.status).toBe("running");
      expect((detail.workspace as { path: string }).path).toBe(join(fixture.workspaceRoot, "AA-1"));

      const missing = await fetch(`${base}/api/v1/NOPE-9`);
      expect(missing.status).toBe(404);
      expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("issue_not_found");

      const refresh = await fetch(`${base}/api/v1/refresh`, { method: "POST" });
      expect(refresh.status).toBe(202);
      expect(((await refresh.json()) as { queued: boolean }).queued).toBe(true);

      const wrongMethod = await fetch(`${base}/api/v1/state`, { method: "POST" });
      expect(wrongMethod.status).toBe(405);

      const dashboard = await fetch(base);
      expect(dashboard.headers.get("content-type")).toContain("text/html");
      expect(await dashboard.text()).toContain("cli-exec");
    } finally {
      server.stop();
      await orchestrator.stop();
    }
  }, 20_000);
});

describe("cli argument parsing", () => {
  test("defaults, positional workflow path, and flags", () => {
    expect(parseArgs([])).toMatchObject({ workflowPath: "./WORKFLOW.md", port: null, logLevel: "info" });
    expect(parseArgs(["custom/WORKFLOW.md"])).toMatchObject({ workflowPath: "custom/WORKFLOW.md" });
    expect(parseArgs(["--port", "8080"])).toMatchObject({ port: 8080 });
    expect(parseArgs(["--port=9090", "--log-level=debug"])).toMatchObject({ port: 9090, logLevel: "debug" });
    expect(parseArgs(["--help"]).help).toBe(true);
  });
});

describe("workflow reload", () => {
  test("editing WORKFLOW.md re-applies config without a restart", async () => {
    const fixture = await workflowFixture({
      issues: [{ id: "a", identifier: "AA-1" } as Partial<Issue>],
      runnerBlock: ["runner:", "  kind: cli-exec", '  command: "true"', "  stall_timeout_ms: 0"].join("\n"),
    });
    fixtures.push(fixture);

    const orchestrator = new Orchestrator({
      workflowPath: fixture.path,
      logger: quietLogger(),
      agents: defaultAgentRegistry(),
      trackers: defaultTrackerRegistry(),
    });
    await orchestrator.start();
    expect(orchestrator.config?.agent.max_concurrent_agents).toBe(4);

    const text = await Bun.file(fixture.path).text();
    await Bun.write(fixture.path, text.replace("max_concurrent_agents: 4", "max_concurrent_agents: 9"));
    const reloaded = await orchestrator.reload();

    expect(reloaded.ok).toBe(true);
    expect(orchestrator.config?.agent.max_concurrent_agents).toBe(9);
    await orchestrator.stop();
  }, 20_000);

  test("an invalid reload keeps the last known good configuration", async () => {
    const fixture = await workflowFixture({
      issues: [],
      runnerBlock: ["runner:", "  kind: cli-exec", '  command: "true"'].join("\n"),
    });
    fixtures.push(fixture);

    const orchestrator = new Orchestrator({
      workflowPath: fixture.path,
      logger: quietLogger(),
      agents: defaultAgentRegistry(),
      trackers: defaultTrackerRegistry(),
    });
    await orchestrator.start();
    const good = orchestrator.config;
    expect(good).not.toBeNull();

    await Bun.write(fixture.path, "---\n: not valid yaml :\n---\nbody\n");
    const reloaded = await orchestrator.reload();

    expect(reloaded.ok).toBe(false);
    expect(orchestrator.config).toBe(good!); // unchanged
    await orchestrator.stop();
  }, 20_000);
});
