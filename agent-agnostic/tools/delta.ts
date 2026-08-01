/**
 * Delta engine.
 *
 * Parses `DELTA.md` and applies it to the upstream specification to produce the forked
 * specification. The contract implemented here is documented in `RULES.md` sections 4 and 5;
 * that document is the specification for this file, not the other way around.
 *
 * The central idea is the region list. The document is a sequence of regions, each either
 * MUTABLE (upstream-derived text that ops may still anchor on and rename) or FROZEN (text
 * introduced by a patch file). Frozen regions are invisible to every later op, which is what lets
 * patch files be written in fork terminology without a later rename mangling them.
 */

import { basename, dirname, join } from "node:path";

export type Region = { text: string; frozen: boolean };

export type RenameEntry = { from: string; to: string; expect: number };

export type DeltaOp =
  | { op: "rename-table"; entries: RenameEntry[] }
  | { op: "replace-section"; section: string; patch: string }
  | { op: "insert-after-section"; section: string; patch: string }
  | { op: "replace-text"; patch: string }
  | { op: "append"; patch: string }
  | { op: "prepend"; patch: string };

export type DeltaEntry = {
  id: string;
  title: string;
  prose: string;
  ops: DeltaOp[];
};

export type DeltaDocument = {
  meta: { upstream: string; output: string; lock: string };
  entries: DeltaEntry[];
};

export class DeltaError extends Error {
  constructor(
    readonly deltaId: string,
    readonly detail: string,
    readonly hint?: string,
  ) {
    super(`[${deltaId}] ${detail}${hint ? `\n         hint: ${hint}` : ""}`);
    this.name = "DeltaError";
  }
}

const DELTA_ID = /^##\s+(D-\d{3})\s+—\s+(.+?)\s*$/;
const MARKER = /<!--\s*delta:\s*(D-\d{3})\s*-->/g;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseFences(body: string): { lang: string; content: string }[] {
  const out: { lang: string; content: string }[] = [];
  const lines = body.split("\n");
  let open: { lang: string; buf: string[] } | null = null;

  for (const line of lines) {
    const fence = /^```(\S*)\s*$/.exec(line);
    if (fence && !open) {
      open = { lang: fence[1] ?? "", buf: [] };
      continue;
    }
    if (line.trimEnd() === "```" && open) {
      out.push({ lang: open.lang, content: open.buf.join("\n") });
      open = null;
      continue;
    }
    if (open) open.buf.push(line);
  }
  return out;
}

function asOp(id: string, raw: unknown): DeltaOp {
  if (typeof raw !== "object" || raw === null) {
    throw new DeltaError(id, "delta block did not decode to a mapping");
  }
  const value = raw as Record<string, unknown>;
  const op = value.op;

  const patchOf = () => {
    if (typeof value.patch !== "string" || value.patch.length === 0) {
      throw new DeltaError(id, `op '${String(op)}' requires a 'patch' key`);
    }
    return value.patch;
  };
  const sectionOf = () => {
    if (typeof value.section !== "string" || value.section.length === 0) {
      throw new DeltaError(id, `op '${String(op)}' requires a 'section' key`);
    }
    return value.section;
  };

  switch (op) {
    case "rename-table": {
      const entries = value.entries;
      if (!Array.isArray(entries) || entries.length === 0) {
        throw new DeltaError(id, "rename-table requires a non-empty 'entries' list");
      }
      return {
        op: "rename-table",
        entries: entries.map((entry, index) => {
          const e = entry as Record<string, unknown>;
          if (typeof e.from !== "string" || typeof e.to !== "string") {
            throw new DeltaError(id, `rename entry ${index} needs string 'from' and 'to'`);
          }
          if (typeof e.expect !== "number" || !Number.isInteger(e.expect) || e.expect < 1) {
            throw new DeltaError(
              id,
              `rename entry '${e.from}' needs an integer 'expect' >= 1`,
              "expect makes upstream drift loud instead of silent; see RULES.md 4.2",
            );
          }
          return { from: e.from, to: e.to, expect: e.expect };
        }),
      };
    }
    case "replace-section":
      return { op: "replace-section", section: sectionOf(), patch: patchOf() };
    case "insert-after-section":
      return { op: "insert-after-section", section: sectionOf(), patch: patchOf() };
    case "replace-text":
      return { op: "replace-text", patch: patchOf() };
    case "append":
      return { op: "append", patch: patchOf() };
    case "prepend":
      return { op: "prepend", patch: patchOf() };
    default:
      throw new DeltaError(id, `unknown op '${String(op)}'`, "see RULES.md 4.2 for the op list");
  }
}

export function parseDelta(source: string): DeltaDocument {
  const metaFence = parseFences(source).find((f) => f.lang === "delta-meta");
  if (!metaFence) throw new Error("DELTA.md is missing its ```delta-meta block");
  const meta = Bun.YAML.parse(metaFence.content) as DeltaDocument["meta"];
  for (const key of ["upstream", "output", "lock"] as const) {
    if (typeof meta?.[key] !== "string") {
      throw new Error(`delta-meta is missing '${key}'`);
    }
  }

  const lines = source.split("\n");
  const entries: DeltaEntry[] = [];
  let current: { id: string; title: string; buf: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const body = current.buf.join("\n");
    const ops = parseFences(body)
      .filter((f) => f.lang === "delta")
      .map((f) => asOp(current!.id, Bun.YAML.parse(f.content)));
    const prose = body
      .split("\n")
      .filter((l) => !l.startsWith("```"))
      .join("\n")
      .trim();
    entries.push({ id: current.id, title: current.title, prose, ops });
    current = null;
  };

  for (const line of lines) {
    const heading = DELTA_ID.exec(line);
    if (heading) {
      flush();
      current = { id: heading[1]!, title: heading[2]!, buf: [] };
      continue;
    }
    if (current) current.buf.push(line);
  }
  flush();

  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) throw new DeltaError(entry.id, "duplicate delta id");
    seen.add(entry.id);
  }
  return { meta, entries };
}

// ---------------------------------------------------------------------------
// Region helpers
// ---------------------------------------------------------------------------

function render(regions: Region[]): string {
  return regions.map((r) => r.text).join("");
}

/** Locate `needle` across mutable regions only. Ambiguity and absence are both errors. */
function locate(regions: Region[], needle: string, id: string, what: string) {
  const hits: { index: number; offset: number }[] = [];
  regions.forEach((region, index) => {
    if (region.frozen) return;
    let from = 0;
    for (;;) {
      const offset = region.text.indexOf(needle, from);
      if (offset === -1) break;
      hits.push({ index, offset });
      from = offset + 1;
    }
  });
  if (hits.length === 0) {
    throw new DeltaError(
      id,
      `${what} did not match upstream text`,
      "upstream probably rewrote this passage — bucket B or D in RULES.md 6.2",
    );
  }
  if (hits.length > 1) {
    throw new DeltaError(
      id,
      `${what} matched ${hits.length} times and must match exactly once`,
      "widen the anchor until it is unique",
    );
  }
  return hits[0]!;
}

/** Replace [start, end) inside one mutable region with a frozen replacement. */
function spliceRegion(
  regions: Region[],
  index: number,
  start: number,
  end: number,
  replacement: string,
): Region[] {
  const region = regions[index]!;
  const before = region.text.slice(0, start);
  const after = region.text.slice(end);
  const inserted: Region[] = [];
  if (before) inserted.push({ text: before, frozen: false });
  if (replacement) inserted.push({ text: replacement, frozen: true });
  if (after) inserted.push({ text: after, frozen: false });
  return [...regions.slice(0, index), ...inserted, ...regions.slice(index + 1)];
}

function headingLevel(line: string): number {
  const m = /^(#{1,6})\s/.exec(line);
  return m ? m[1]!.length : 0;
}

/**
 * Span of a section: from the heading line through the last line before the next heading of the
 * same or higher level. Returned offsets are relative to the containing mutable region.
 */
function sectionSpan(regions: Region[], heading: string, id: string) {
  const hit = locate(regions, heading, id, `section heading '${heading}'`);
  const region = regions[hit.index]!;
  if (hit.offset !== 0 && region.text[hit.offset - 1] !== "\n") {
    throw new DeltaError(id, `section heading '${heading}' is not at the start of a line`);
  }
  const level = headingLevel(heading);
  if (level === 0) throw new DeltaError(id, `'${heading}' is not a Markdown heading`);

  const rest = region.text.slice(hit.offset);
  const lines = rest.split("\n");
  let consumed = lines[0]!.length + 1;
  let end = region.text.length;
  for (let i = 1; i < lines.length; i++) {
    const lvl = headingLevel(lines[i]!);
    if (lvl > 0 && lvl <= level) {
      end = hit.offset + consumed;
      break;
    }
    consumed += lines[i]!.length + 1;
  }
  return { index: hit.index, start: hit.offset, end };
}

const FIND_OPEN = "<<<<<<< FIND\n";
const FIND_SPLIT = "\n=======\n";
const FIND_CLOSE = "\n>>>>>>> REPLACE";

export function parsePatchBlocks(id: string, patchPath: string, text: string) {
  const blocks: { find: string; replace: string }[] = [];
  let cursor = 0;
  for (;;) {
    const open = text.indexOf(FIND_OPEN, cursor);
    if (open === -1) break;
    const split = text.indexOf(FIND_SPLIT, open);
    const close = text.indexOf(FIND_CLOSE, split === -1 ? open : split);
    if (split === -1 || close === -1) {
      throw new DeltaError(id, `patch '${patchPath}' has an unterminated FIND/REPLACE block`);
    }
    blocks.push({
      find: text.slice(open + FIND_OPEN.length, split),
      replace: text.slice(split + FIND_SPLIT.length, close),
    });
    cursor = close + FIND_CLOSE.length;
  }
  if (blocks.length === 0) {
    throw new DeltaError(id, `patch '${patchPath}' contains no FIND/REPLACE blocks`);
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

export type ApplyResult = {
  output: string;
  renameCounts: Map<string, number>;
  markers: Map<string, number>;
};

export async function applyDelta(
  upstream: string,
  delta: DeltaDocument,
  deltaDir: string,
): Promise<ApplyResult> {
  let regions: Region[] = [{ text: upstream, frozen: false }];
  const renameCounts = new Map<string, number>();

  const readPatch = async (id: string, relative: string) => {
    const path = join(deltaDir, relative);
    const file = Bun.file(path);
    if (!(await file.exists())) {
      throw new DeltaError(id, `patch file '${relative}' does not exist`);
    }
    const text = await file.text();
    if (!text.includes(`<!-- delta: ${id} -->`)) {
      throw new DeltaError(
        id,
        `patch '${relative}' is missing its own marker '<!-- delta: ${id} -->'`,
        "every patch must be traceable from the generated spec back to DELTA.md (RULES.md 4.5)",
      );
    }
    return text;
  };

  for (const entry of delta.entries) {
    if (entry.ops.length === 0) {
      throw new DeltaError(entry.id, "delta entry has prose but no ops", "retired? see RULES.md 6.1");
    }
    for (const op of entry.ops) {
      switch (op.op) {
        case "replace-section": {
          const patch = await readPatch(entry.id, op.patch);
          const span = sectionSpan(regions, op.section, entry.id);
          regions = spliceRegion(regions, span.index, span.start, span.end, patch);
          break;
        }
        case "insert-after-section": {
          const patch = await readPatch(entry.id, op.patch);
          const span = sectionSpan(regions, op.section, entry.id);
          regions = spliceRegion(
            regions,
            span.index,
            span.end,
            span.end,
            patch,
          );
          break;
        }
        case "replace-text": {
          const patch = await readPatch(entry.id, op.patch);
          for (const block of parsePatchBlocks(entry.id, op.patch, patch)) {
            const hit = locate(
              regions,
              block.find,
              entry.id,
              `patch '${op.patch}' FIND block starting "${block.find.split("\n")[0]!.slice(0, 60)}"`,
            );
            regions = spliceRegion(
              regions,
              hit.index,
              hit.offset,
              hit.offset + block.find.length,
              block.replace,
            );
          }
          break;
        }
        case "append": {
          const patch = await readPatch(entry.id, op.patch);
          regions = [...regions, { text: patch, frozen: true }];
          break;
        }
        case "prepend": {
          const patch = await readPatch(entry.id, op.patch);
          regions = [{ text: patch, frozen: true }, ...regions];
          break;
        }
        case "rename-table": {
          for (const rename of op.entries) {
            let count = 0;
            regions = regions.map((region) => {
              if (region.frozen) return region;
              const parts = region.text.split(rename.from);
              count += parts.length - 1;
              return { ...region, text: parts.join(rename.to) };
            });
            renameCounts.set(rename.from, count);
            if (count !== rename.expect) {
              throw new DeltaError(
                entry.id,
                `rename '${rename.from}' -> '${rename.to}' matched ${count} time(s), expected ${rename.expect}`,
                count === 0
                  ? "upstream removed or renamed this identifier — bucket B in RULES.md 6.2"
                  : "upstream added or removed occurrences — update 'expect' after confirming each site",
              );
            }
          }
          break;
        }
      }
    }
  }

  const output = render(regions);
  const markers = new Map<string, number>();
  for (const match of output.matchAll(MARKER)) {
    const id = match[1]!;
    markers.set(id, (markers.get(id) ?? 0) + 1);
  }
  return { output, renameCounts, markers };
}

export function sha256(text: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  return hasher.digest("hex");
}

export type BuildContext = {
  root: string;
  deltaPath: string;
  upstreamPath: string;
  outputPath: string;
  lockPath: string;
  delta: DeltaDocument;
  upstream: string;
};

export async function loadContext(root: string): Promise<BuildContext> {
  const deltaPath = join(root, "DELTA.md");
  const source = await Bun.file(deltaPath).text();
  const delta = parseDelta(source);
  const upstreamPath = join(root, delta.meta.upstream);
  const upstream = await Bun.file(upstreamPath).text();
  return {
    root,
    deltaPath,
    upstreamPath,
    outputPath: join(root, delta.meta.output),
    lockPath: join(root, delta.meta.lock),
    delta,
    upstream,
  };
}

export async function upstreamCommit(path: string): Promise<string | null> {
  const proc = Bun.spawn(["git", "log", "-1", "--format=%H", "--", basename(path)], {
    cwd: dirname(path),
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return out.length === 40 ? out : null;
}
