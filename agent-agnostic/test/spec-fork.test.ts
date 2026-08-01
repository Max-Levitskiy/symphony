/**
 * Fork consistency (RULES.md section 5, invariants I1-I5).
 *
 * If this fails, the fork's SPEC.md no longer describes what DELTA.md says it does. That is a
 * documentation bug with the same severity as a code bug, so it lives in the same suite.
 */

import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { checkSpec } from "../tools/spec-check.ts";
import { parseDelta } from "../tools/delta.ts";

const root = resolve(dirname(Bun.fileURLToPath(import.meta.url)), "..");

describe("spec fork", () => {
  test("generated SPEC.md matches a fresh build of DELTA.md against upstream", async () => {
    const failures = await checkSpec(root);
    expect(failures.map((f) => `${f.code}: ${f.message}`)).toEqual([]);
  });

  test("every delta entry has prose and at least one op", async () => {
    const delta = parseDelta(await Bun.file(resolve(root, "DELTA.md")).text());
    expect(delta.entries.length).toBeGreaterThan(0);
    for (const entry of delta.entries) {
      expect(entry.ops.length, `${entry.id} has no ops`).toBeGreaterThan(0);
      expect(entry.prose.length, `${entry.id} has no prose`).toBeGreaterThan(80);
    }
  });

  test("the section 10 agent contract names no coding-agent vendor", async () => {
    const spec = await Bun.file(resolve(root, "SPEC.md")).text();
    const start = spec.indexOf("## 10. Agent Runtime Integration Contract");
    const end = spec.indexOf("## 11. Issue Tracker Integration Contract");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);

    const offenders = spec
      .slice(start, end)
      .split("\n")
      .map((line, index) => ({ line, number: index + 1 }))
      // The one permitted mention explains what this section replaced upstream.
      .filter(({ line }) => /codex|app-server/i.test(line) && !/upstream/i.test(line));

    expect(offenders.map((o) => `${o.number}: ${o.line.trim()}`)).toEqual([]);
  });

  test("orchestrator code names no coding-agent vendor outside its adapter", async () => {
    const vendorOwned = new Set([
      "src/agent/codex-app-server.ts",
      "src/agent/claude-code.ts",
      "src/agent/cli-exec.ts",
      "src/agent/registry.ts", // registration only
      "src/index.ts", // re-exports only
      "src/config/schema.ts", // the documented legacy `codex:` shim
    ]);

    const glob = new Bun.Glob("src/**/*.ts");
    const offenders: string[] = [];
    for await (const relative of glob.scan(root)) {
      if (vendorOwned.has(relative)) continue;
      const text = await Bun.file(resolve(root, relative)).text();
      text.split("\n").forEach((line, index) => {
        if (/\bcodex\b|\bclaude\b|\banthropic\b|\bopenai\b/i.test(line)) {
          offenders.push(`${relative}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  test("Appendix B capability tables match what the adapters actually declare", async () => {
    const { defaultAgentRegistry } = await import("../src/agent/registry.ts");
    const { CAPABILITY_KEYS } = await import("../src/agent/types.ts");
    const spec = await Bun.file(resolve(root, "SPEC.md")).text();
    const registry = defaultAgentRegistry();

    const documented = new Map<string, boolean[]>();
    const pattern = /###\s+B\.\d+\s+`([^`]+)`[\s\S]*?- Capabilities:\s*`([^`]+)`/g;
    for (const match of spec.matchAll(pattern)) {
      documented.set(
        match[1]!,
        match[2]!.split("/").map((v) => v.trim() === "true"),
      );
    }

    // Every shipped adapter is documented, and every documented adapter is shipped.
    expect([...documented.keys()].sort()).toEqual(registry.kinds());

    for (const [kind, flags] of documented) {
      const resolved = registry.resolve(kind);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) continue;
      const actual = resolved.value.capabilities();
      expect(flags.length, `${kind} table must list all ${CAPABILITY_KEYS.length} capabilities`).toBe(
        CAPABILITY_KEYS.length,
      );
      CAPABILITY_KEYS.forEach((key, index) => {
        expect(actual[key], `${kind}.${key} disagrees with Appendix B`).toBe(flags[index]!);
      });
    }
  });

  test("upstream section numbering is preserved", async () => {
    const upstream = await Bun.file(resolve(root, "..", "SPEC.md")).text();
    const fork = await Bun.file(resolve(root, "SPEC.md")).text();

    const numbered = (text: string) =>
      text
        .split("\n")
        .filter((l) => /^#{2,4}\s+(\d+\.|Appendix\s+A)/.test(l))
        .map((l) => l.replace(/^(#{2,4}\s+(?:\d+(?:\.\d+)*\.?|Appendix\s+A))\s.*/, "$1"));

    // Every upstream section number still exists in the fork, in the same relative order. The fork
    // may add sub-sections (10.8-10.10) and appendices; it may never renumber or drop one.
    const forkHeadings = numbered(fork);
    const missing: string[] = [];
    let cursor = 0;
    for (const heading of numbered(upstream)) {
      const at = forkHeadings.indexOf(heading, cursor);
      if (at === -1) missing.push(heading);
      else cursor = at + 1;
    }
    expect(missing).toEqual([]);
  });
});
