/** Workspace manager and safety invariants (forked spec 17.2). */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkspaceManager, workspaceKey, assertInsideRoot } from "../src/workspace/manager.ts";
import { cleanup, quietLogger, tempDir } from "./support/fixtures.ts";

const dirs: string[] = [];

async function newManager(hooks: Partial<Record<string, string | null>> = {}) {
  const root = join(await tempDir(), "workspaces");
  dirs.push(root);
  return new WorkspaceManager({
    root,
    hooks: {
      after_create: (hooks.after_create as string) ?? null,
      before_run: (hooks.before_run as string) ?? null,
      after_run: (hooks.after_run as string) ?? null,
      before_remove: (hooks.before_remove as string) ?? null,
      timeout_ms: 5_000,
    },
    logger: quietLogger(),
  });
}

afterEach(async () => {
  await cleanup(...dirs.splice(0));
});

describe("workspace keys", () => {
  test("an already-safe identifier is used verbatim", () => {
    expect(workspaceKey("AA-123")).toBe("AA-123");
    expect(workspaceKey("proj.sub_1")).toBe("proj.sub_1");
  });

  test("identifiers that sanitize to the same text still get distinct keys", () => {
    const a = workspaceKey("feature/AB-1");
    const b = workspaceKey("feature:AB-1");
    expect(a).toStartWith("feature_AB-1-");
    expect(b).toStartWith("feature_AB-1-");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  test("keys are deterministic across calls", () => {
    expect(workspaceKey("a b/c")).toBe(workspaceKey("a b/c"));
  });

  test("an empty identifier is rejected", () => {
    expect(() => workspaceKey("")).toThrow();
  });
});

describe("root containment", () => {
  test("paths outside the root are rejected", () => {
    expect(() => assertInsideRoot("/root", "/root/ok")).not.toThrow();
    expect(() => assertInsideRoot("/root", "/root")).toThrow(/escapes/);
    expect(() => assertInsideRoot("/root", "/elsewhere")).toThrow(/escapes/);
    expect(() => assertInsideRoot("/root", "/root/../elsewhere")).toThrow(/escapes/);
  });
});

describe("create and reuse", () => {
  test("creates once, then reuses", async () => {
    const wm = await newManager();
    const first = await wm.ensure("AA-1");
    expect(first.created_now).toBe(true);
    expect((await stat(first.path)).isDirectory()).toBe(true);

    const second = await wm.ensure("AA-1");
    expect(second.created_now).toBe(false);
    expect(second.path).toBe(first.path);
  });

  test("a non-directory at the workspace path is refused rather than clobbered", async () => {
    const wm = await newManager();
    await mkdir(wm.root, { recursive: true });
    await writeFile(join(wm.root, "AA-2"), "not a directory");
    await expect(wm.ensure("AA-2")).rejects.toThrow(/not a directory/);
  });
});

describe("hooks", () => {
  test("after_create runs only on creation", async () => {
    const wm = await newManager({ after_create: "echo created > marker.txt" });
    const created = await wm.ensure("AA-1");
    expect(await Bun.file(join(created.path, "marker.txt")).text()).toContain("created");

    await Bun.write(join(created.path, "marker.txt"), "");
    await wm.ensure("AA-1");
    expect(await Bun.file(join(created.path, "marker.txt")).text()).toBe("");
  });

  test("a failing after_create aborts creation and leaves no directory behind", async () => {
    const wm = await newManager({ after_create: "exit 3" });
    await expect(wm.ensure("AA-1")).rejects.toThrow(/after_create/);
    await expect(stat(wm.pathFor("AA-1"))).rejects.toThrow();
  });

  test("a failing before_run reports failure without throwing", async () => {
    const wm = await newManager({ before_run: "exit 1" });
    const workspace = await wm.ensure("AA-1");
    const outcome = await wm.runHook("before_run", workspace.path);
    expect(outcome).toMatchObject({ ran: true, ok: false });
  });

  test("hooks that exceed the timeout are reported as failures", async () => {
    const root = join(await tempDir(), "workspaces");
    dirs.push(root);
    const wm = new WorkspaceManager({
      root,
      hooks: { after_create: null, before_run: "sleep 5", after_run: null, before_remove: null, timeout_ms: 150 },
      logger: quietLogger(),
    });
    const workspace = await wm.ensure("AA-1");
    const outcome = await wm.runHook("before_run", workspace.path);
    expect(outcome.ok).toBe(false);
  });

  test("an unconfigured hook is a no-op", async () => {
    const wm = await newManager();
    expect(await wm.runHook("after_run", (await wm.ensure("AA-1")).path)).toMatchObject({ ran: false });
  });
});

describe("removal", () => {
  test("before_remove runs and the directory goes away", async () => {
    const wm = await newManager({ before_remove: "echo bye" });
    const workspace = await wm.ensure("AA-1");
    expect(await wm.remove("AA-1")).toBe(true);
    await expect(stat(workspace.path)).rejects.toThrow();
  });

  test("removing a workspace that does not exist is a no-op", async () => {
    const wm = await newManager();
    expect(await wm.remove("never-existed")).toBe(false);
  });
});
