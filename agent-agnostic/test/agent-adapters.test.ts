/**
 * Agent adapter contract and capability fallbacks (forked spec 17.5).
 *
 * These are the tests that prove the fork's claim. The last one is the important one: two adapters
 * with different capability sets must drive the same issue lifecycle to the same outcome, differing
 * only in prompt content and telemetry.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { AgentRegistry } from "../src/agent/registry.ts";
import { AGENT_EVENT_NAMES, CAPABILITY_KEYS } from "../src/agent/types.ts";
import { codexAppServerAdapter } from "../src/agent/codex-app-server.ts";
import { claudeCodeAdapter } from "../src/agent/claude-code.ts";
import { cliExecAdapter } from "../src/agent/cli-exec.ts";
import { runAgentAttempt, childEnvironment } from "../src/orchestrator/worker.ts";
import { WorkspaceManager } from "../src/workspace/manager.ts";
import { MemoryTracker } from "../src/tracker/memory.ts";
import { resolveConfig } from "../src/config/schema.ts";
import { parseWorkflow } from "../src/workflow/loader.ts";
import type { EffectiveConfig } from "../src/config/schema.ts";
import type { AgentEvent } from "../src/agent/types.ts";
import { mockAdapter, type MockScript } from "./support/mock-adapter.ts";
import { cleanup, issue, quietLogger, tempDir } from "./support/fixtures.ts";

const dirs: string[] = [];
afterEach(async () => {
  await cleanup(...dirs.splice(0));
});

function configFor(root: string, overrides: Partial<EffectiveConfig["runner"]> = {}): EffectiveConfig {
  const workflow = parseWorkflow(
    `---
tracker:
  kind: memory
  active_states: [Todo]
  terminal_states: [Done]
runner:
  kind: mock
agent:
  max_turns: 3
---
Task {{ issue.identifier }}: {{ issue.title }}
`,
  );
  if (!workflow.ok) throw new Error("fixture workflow failed to parse");
  const resolved = resolveConfig(workflow.value, join(root, "WORKFLOW.md"), {});
  if (!resolved.ok) throw new Error(resolved.error.message);
  return {
    ...resolved.value,
    workspace: { root: join(root, "workspaces") },
    runner: { ...resolved.value.runner, ...overrides },
  };
}

async function runOnce(script: MockScript, options: { issues?: ReturnType<typeof issue>[] } = {}) {
  const root = await tempDir();
  dirs.push(root);
  const config = configFor(root);
  const { adapter, record } = mockAdapter(script);
  const target = options.issues?.[0] ?? issue();
  const tracker = new MemoryTracker({ records: options.issues ?? [target] });
  const events: AgentEvent[] = [];

  const exit = await runAgentAttempt({
    issue: target,
    attempt: null,
    config,
    workspaces: new WorkspaceManager({ root: config.workspace.root, hooks: config.hooks, logger: quietLogger() }),
    tracker,
    adapter,
    logger: quietLogger(),
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  });
  return { exit, record, events, config };
}

describe("shipped adapters declare a complete, honest capability set", () => {
  for (const adapter of [codexAppServerAdapter, claudeCodeAdapter, cliExecAdapter]) {
    test(`${adapter.kind} declares every capability explicitly`, () => {
      const capabilities = adapter.capabilities();
      for (const key of CAPABILITY_KEYS) {
        expect(typeof capabilities[key], `${adapter.kind}.${key}`).toBe("boolean");
      }
      expect(Object.keys(capabilities).sort()).toEqual([...CAPABILITY_KEYS].sort());
    });
  }

  test("cli-exec declares every capability false, which exercises every fallback", () => {
    expect(Object.values(cliExecAdapter.capabilities()).some(Boolean)).toBe(false);
  });

  test("cli-exec refuses to start without an explicit command", () => {
    const result = cliExecAdapter.validateConfig({
      kind: "cli-exec",
      command: null,
      provider: {},
      env: {},
      require_client_tools: false,
      turn_timeout_ms: 1000,
      read_timeout_ms: 1000,
      stall_timeout_ms: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.category).toBe("invalid_runner_config");
  });
});

describe("registry", () => {
  test("an unregistered kind fails with unsupported_agent_kind", () => {
    const registry = new AgentRegistry().register(cliExecAdapter);
    const result = registry.resolve("nope");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("unsupported_agent_kind");
      expect(result.error.message).toContain("cli-exec");
    }
  });
});

describe("capability fallback: session_continuation", () => {
  test("true — continuation turns send guidance only", async () => {
    const { exit, record } = await runOnce({ capabilities: { session_continuation: true } });
    expect(exit.reason).toBe("normal");
    expect(record.turns.length).toBe(3); // max_turns
    expect(record.turns[0]!.text).toContain("Task AA-1");
    expect(record.turns[1]!.text).not.toContain("Task AA-1");
    expect(record.turns[1]!.text).toContain("Continue the work");
    expect(record.turns[1]!.kind).toBe("continuation");
    expect(record.sessions).toBe(1);
  });

  test("false — every turn resends the full task, and the session key stays stable", async () => {
    const { exit, record } = await runOnce({ capabilities: { session_continuation: false } });
    expect(exit.reason).toBe("normal");
    expect(record.turns.length).toBe(3);
    for (const turn of record.turns) expect(turn.text).toContain("Task AA-1");
    expect(record.turns[1]!.text).toContain("Continue the work");
    // One session across all turns: logs and snapshots stay correlated (spec 10.5).
    expect(record.sessions).toBe(1);
  });
});

describe("capability fallback: client_tools", () => {
  test("true — the tracker's tools are advertised", async () => {
    const { record } = await runOnce({ capabilities: { client_tools: true } });
    expect(record.toolsAdvertised[0]).toEqual(["set_issue_state", "add_issue_comment"]);
  });

  test("false — no tools are advertised, one notice is emitted, and the run still completes", async () => {
    const { exit, record, events } = await runOnce({ capabilities: { client_tools: false } });
    expect(exit.reason).toBe("normal");
    expect(record.toolsAdvertised[0]).toEqual([]);
    expect(events.filter((e) => e.event === "client_tools_unavailable").length).toBe(1);
  });
});

describe("capability fallback: streaming_events", () => {
  test("false — only session start and a terminal turn event are emitted", async () => {
    const { events } = await runOnce({ capabilities: { streaming_events: false } });
    expect(events.some((e) => e.event === "session_started")).toBe(true);
    expect(events.some((e) => e.event === "turn_started")).toBe(false);
    expect(events.filter((e) => e.event === "turn_completed").length).toBe(3);
  });
});

describe("turn outcomes", () => {
  for (const status of ["failed", "cancelled", "timed_out", "input_required"] as const) {
    test(`${status} fails the attempt`, async () => {
      const { exit } = await runOnce({ statuses: [status] });
      expect(exit.reason).toBe("error");
      expect(exit.error).toContain(status);
    });
  }

  test("a startup failure fails the attempt without running turns", async () => {
    const { exit, record } = await runOnce({ startupError: "boom" });
    expect(exit.reason).toBe("error");
    expect(exit.error).toContain("boom");
    expect(record.turns.length).toBe(0);
  });

  test("only names from the normalized vocabulary are emitted", async () => {
    const { events } = await runOnce({});
    for (const event of events) expect(AGENT_EVENT_NAMES).toContain(event.event);
  });
});

describe("session environment", () => {
  test("tracker secrets are removed and runner.env is applied", async () => {
    const root = await tempDir();
    dirs.push(root);
    const config = configFor(root, { env: { AGENT_TOKEN: "agent-secret" } });
    const tracker = new MemoryTracker({ records: [issue()] });
    const env = childEnvironment(config, tracker, {
      GITHUB_TOKEN: "tracker-secret",
      PATH: "/usr/bin",
      AGENT_TOKEN: "stale",
    });
    // MemoryTracker declares no secrets, so simulate one that does.
    const withSecrets = childEnvironment(
      config,
      { ...tracker, secretEnvironmentNames: () => ["GITHUB_TOKEN"] } as typeof tracker,
      { GITHUB_TOKEN: "tracker-secret", PATH: "/usr/bin" },
    );

    expect(env.AGENT_TOKEN).toBe("agent-secret");
    expect(withSecrets.GITHUB_TOKEN).toBeUndefined();
    expect(withSecrets.PATH).toBe("/usr/bin");
  });

  test("the session runs in the per-issue workspace directory", async () => {
    const { record, config } = await runOnce({});
    expect(record.workspaces[0]).toBe(join(config.workspace.root, "AA-1"));
  });
});

describe("two adapters, same lifecycle", () => {
  test("a full-capability and a zero-capability adapter reach the same outcome", async () => {
    const full = await runOnce({ kind: "full", capabilities: {} });
    const none = await runOnce({
      kind: "none",
      capabilities: {
        session_continuation: false,
        streaming_events: false,
        client_tools: false,
        approvals: false,
        cancellation: false,
        usage_reporting: false,
        rate_limit_reporting: false,
      },
    });

    // Same orchestration outcome and same turn count...
    expect(none.exit).toEqual(full.exit);
    expect(none.record.turns.length).toBe(full.record.turns.length);

    // ...differing only in prompt content and telemetry.
    expect(full.record.turns[1]!.text).not.toBe(none.record.turns[1]!.text);
    expect(none.events.some((e) => e.event === "turn_started")).toBe(false);
    expect(full.events.some((e) => e.event === "turn_started")).toBe(true);
  });
});
