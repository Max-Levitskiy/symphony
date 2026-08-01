/** Tracker adapter contract and normalization (forked spec 17.3). */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { MemoryTracker } from "../src/tracker/memory.ts";
import { defaultTrackerRegistry } from "../src/tracker/registry.ts";
import { normalizeIssue } from "../src/tracker/types.ts";
import { cleanup, issue, quietLogger, tempDir } from "./support/fixtures.ts";

const dirs: string[] = [];
afterEach(async () => {
  await cleanup(...dirs.splice(0));
});

describe("normalization", () => {
  test("labels are trimmed, lowercased, de-duplicated, and blanks dropped", () => {
    const result = normalizeIssue({
      id: "1",
      identifier: "AA-1",
      title: "t",
      state: "Todo",
      dispatchable: true,
      labels: ["  Bug ", "bug", "", "Backend"],
    });
    expect(result.ok && result.issue.labels).toEqual(["bug", "backend"]);
  });

  test("provider state spelling is preserved", () => {
    const result = normalizeIssue({
      id: "1",
      identifier: "AA-1",
      title: "t",
      state: "In Progress",
      dispatchable: true,
    });
    expect(result.ok && result.issue.state).toBe("In Progress");
  });

  test("unusable optional metadata becomes null or empty without hiding required fields", () => {
    const result = normalizeIssue({
      id: "1",
      identifier: "AA-1",
      title: "t",
      state: "Todo",
      dispatchable: true,
      priority: "high",
      created_at: "not a date",
      native_ref: ["not", "an", "object"],
      blocked_by: "nope",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.issue.priority).toBeNull();
    expect(result.issue.created_at).toBeNull();
    expect(result.issue.native_ref).toBeNull();
    expect(result.issue.blocked_by).toEqual([]);
  });

  test("missing required fields and an implicit dispatchable are rejected", () => {
    expect(normalizeIssue({ identifier: "AA-1", title: "t", state: "Todo", dispatchable: true }).ok).toBe(false);
    expect(normalizeIssue({ id: "1", identifier: "AA-1", title: "t", state: "Todo" }).ok).toBe(false);
    expect(normalizeIssue({ id: "1", identifier: " ", title: "t", state: "Todo", dispatchable: true }).ok).toBe(
      false,
    );
  });
});

describe("memory tracker", () => {
  test("empty input lists return empty without touching the provider", async () => {
    const tracker = new MemoryTracker({ path: "/definitely/missing.json" });
    expect(await tracker.fetchIssuesByStates([])).toEqual({ ok: true, value: [] });
    expect(await tracker.fetchIssuesByIds([])).toEqual({ ok: true, value: [] });
  });

  test("state filtering is case-insensitive", async () => {
    const tracker = new MemoryTracker({
      records: [issue({ id: "a", state: "In Progress" }), issue({ id: "b", identifier: "AA-2", state: "Todo" })],
    });
    const result = await tracker.fetchIssuesByStates(["in progress"]);
    expect(result.ok && result.value.map((i) => i.id)).toEqual(["a"]);
  });

  test("a malformed record is omitted by a state list but fails an id refresh", async () => {
    const records = [issue({ id: "a" }), { id: "b", identifier: "AA-2", title: "t" } as never];
    const tracker = new MemoryTracker({ records });

    const list = await tracker.fetchIssuesByStates(["Todo"]);
    expect(list.ok && list.value.map((i) => i.id)).toEqual(["a"]);

    const refresh = await tracker.fetchIssuesByIds(["b"]);
    expect(refresh.ok).toBe(false);
    if (!refresh.ok) expect(refresh.error.category).toBe("tracker_response");
  });

  test("tools mutate the backing file and are scoped to the issue in context", async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const path = join(dir, "issues.json");
    await Bun.write(path, JSON.stringify({ issues: [issue({ id: "a" }), issue({ id: "b", identifier: "AA-2" })] }));

    const tracker = new MemoryTracker({ path });
    const target = issue({ id: "a" });

    expect(await tracker.executeAgentTool("set_issue_state", { state: "Done" }, { issue: target })).toMatchObject({
      success: true,
    });
    expect(
      await tracker.executeAgentTool("add_issue_comment", { body: "on it" }, { issue: target }),
    ).toMatchObject({ success: true });

    const saved = (await Bun.file(path).json()) as { issues: { id: string; state: string; comments?: unknown[] }[] };
    expect(saved.issues.find((i) => i.id === "a")!.state).toBe("Done");
    expect(saved.issues.find((i) => i.id === "a")!.comments).toHaveLength(1);
    expect(saved.issues.find((i) => i.id === "b")!.state).toBe("Todo");
  });

  test("invalid arguments and unknown tool names fail without throwing", async () => {
    const tracker = new MemoryTracker({ records: [issue({ id: "a" })] });
    const context = { issue: issue({ id: "a" }) };
    expect(await tracker.executeAgentTool("set_issue_state", {}, context)).toMatchObject({ success: false });
    expect(await tracker.executeAgentTool("nope", {}, context)).toMatchObject({ success: false });
  });
});

describe("registry", () => {
  test("an unregistered kind fails with unsupported_tracker_kind", () => {
    const result = defaultTrackerRegistry().create(
      { kind: "jira", provider: {}, required_labels: [], active_states: [], terminal_states: [] },
      quietLogger(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.category).toBe("unsupported_tracker_kind");
  });

  test("github requires a repository and a token", () => {
    const registry = defaultTrackerRegistry();
    const missingRepo = registry.create(
      { kind: "github", provider: {}, required_labels: [], active_states: [], terminal_states: [] },
      quietLogger(),
    );
    expect(missingRepo.ok).toBe(false);
    if (!missingRepo.ok) expect(missingRepo.error.category).toBe("invalid_tracker_config");
  });
});
