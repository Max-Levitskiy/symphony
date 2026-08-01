#!/usr/bin/env bun
/**
 * Verify the fork is internally consistent without writing anything.
 *
 * Enforces invariants I1-I5 from RULES.md section 5. Exported as `checkSpec` so the test suite can
 * assert the same thing.
 */

import { dirname, resolve } from "node:path";
import { applyDelta, loadContext, sha256 } from "./delta.ts";

export type CheckFailure = { code: string; message: string };

export async function checkSpec(root: string): Promise<CheckFailure[]> {
  const failures: CheckFailure[] = [];
  const ctx = await loadContext(root);

  // I2 - upstream is pinned.
  const lockFile = Bun.file(ctx.lockPath);
  const lock = (await lockFile.exists())
    ? ((await lockFile.json()) as Record<string, unknown>)
    : null;
  const upstreamHash = sha256(ctx.upstream);
  if (!lock) {
    failures.push({ code: "missing_lock", message: `${ctx.lockPath} does not exist; run spec:build` });
  } else if (lock.upstream_sha256 !== upstreamHash) {
    failures.push({
      code: "upstream_drift",
      message:
        `upstream ${ctx.delta.meta.upstream} changed since this fork was built\n` +
        `    locked: ${lock.upstream_sha256}\n` +
        `    actual: ${upstreamHash}\n` +
        `    follow the sync procedure in RULES.md section 6`,
    });
  }

  // I3/I4 - every anchor resolves, every rename count is exact. applyDelta throws otherwise.
  let output: string;
  let markers: Map<string, number>;
  try {
    const result = await applyDelta(ctx.upstream, ctx.delta, root);
    output = result.output;
    markers = result.markers;
  } catch (error) {
    failures.push({ code: "delta_apply_failed", message: (error as Error).message });
    return failures;
  }

  // I1 - generated output is committed and current.
  const committed = Bun.file(ctx.outputPath);
  if (!(await committed.exists())) {
    failures.push({ code: "missing_output", message: `${ctx.outputPath} does not exist; run spec:build` });
  } else {
    const text = await committed.text();
    if (text !== output) {
      failures.push({
        code: "stale_output",
        message:
          `${ctx.delta.meta.output} differs from a fresh build.\n` +
          `    Either it was hand-edited (edit DELTA.md instead) or spec:build was not re-run.`,
      });
    }
  }

  // I5 - markers round-trip in both directions.
  const declared = new Set(ctx.delta.entries.map((e) => e.id));
  for (const id of markers.keys()) {
    if (!declared.has(id)) {
      failures.push({
        code: "unknown_marker",
        message: `generated spec carries marker ${id} with no matching section in DELTA.md`,
      });
    }
  }
  for (const entry of ctx.delta.entries) {
    const producesText = entry.ops.some((op) => op.op !== "rename-table");
    if (producesText && !markers.has(entry.id)) {
      failures.push({
        code: "missing_marker",
        message: `${entry.id} produces spec text but no '<!-- delta: ${entry.id} -->' marker reached the output`,
      });
    }
  }

  return failures;
}

if (import.meta.main) {
  const root = resolve(dirname(Bun.fileURLToPath(import.meta.url)), "..");
  let failures: CheckFailure[];
  try {
    failures = await checkSpec(root);
  } catch (error) {
    console.error(`spec:check failed\n  ${(error as Error).message}`);
    process.exit(1);
  }
  if (failures.length === 0) {
    console.log("spec:check ok — fork is consistent with upstream and DELTA.md");
  } else {
    for (const failure of failures) {
      console.error(`spec:check ${failure.code}\n    ${failure.message}`);
    }
    process.exit(1);
  }
}
