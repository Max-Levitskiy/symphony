# Fork Rules

How this folder relates to upstream Symphony, how `DELTA.md` works, and exactly what to do when
upstream `SPEC.md` changes.

Read this file before editing anything else in `agent-agnostic/`.

## 1. What this folder is

`agent-agnostic/` is a **derived fork** of the upstream Symphony specification. It exists to remove
the assumption that the coding agent is Codex talking the Codex app-server protocol, and to replace
that assumption with a pluggable **agent adapter** contract — the same shape upstream already uses
for issue trackers.

Nothing outside this folder is modified. Upstream files (`/SPEC.md`, `/elixir/**`, `/README.md`)
stay pristine so upstream merges never conflict.

## 2. File roles

| File | Role | Edited by hand? |
| --- | --- | --- |
| `../SPEC.md` | Upstream specification. The single source of unforked text. | **Never** (it is upstream's) |
| `DELTA.md` | The complete, ordered description of every difference between upstream and this fork. Both human-readable prose and machine-executable ops. | **Yes** — this is the file you edit |
| `patches/*.md` | Replacement text referenced by `DELTA.md` ops. | **Yes** |
| `SPEC.md` | The forked specification. **Generated** by applying `DELTA.md` to `../SPEC.md`. | **No** — regenerate instead |
| `upstream.lock.json` | Pinned SHA-256 of the upstream `SPEC.md` the current delta was authored against, plus the SHA-256 of the generated output. | **No** — written by the build |
| `src/`, `test/` | TypeScript/Bun implementation of the forked spec. | Yes |

The rule that makes everything else work:

> **`SPEC.md` in this folder is build output, not source.** If you want the forked spec to say
> something different, say it in `DELTA.md` (or a patch file) and rebuild. A hand edit to the
> generated `SPEC.md` is lost on the next build and is rejected by `bun run spec:check`.

## 3. Commands

```sh
bun run spec:build     # regenerate SPEC.md + upstream.lock.json from ../SPEC.md + DELTA.md
bun run spec:check     # verify: upstream unchanged, SPEC.md matches a fresh build, delta is well-formed
bun test               # implementation tests (includes spec:check as a test)
```

`spec:check` runs in CI-equivalent mode: it never writes. It fails loudly, with the responsible
delta ID, when anything drifts.

## 4. How `DELTA.md` works

### 4.1 Structure

`DELTA.md` is a Markdown document with:

- one ` ```delta-meta ` block at the top, naming the upstream source and generated target;
- one `## D-NNN — Title` section per change;
- prose under each heading describing the change in plain language (**this is the authoritative
  human description** — it is what a reader should be able to skim to understand the fork);
- one or more ` ```delta ` fenced blocks per section containing the machine-executable ops.

A section with prose but no ops is invalid. An op outside a `D-NNN` section is invalid.

### 4.2 Op vocabulary

Every op is **anchored to exact upstream text**. That is deliberate: when upstream rewrites an
anchored passage, the build fails and names the delta ID that needs review, instead of silently
producing a fork that no longer says what it claims.

| `op` | Keys | Meaning |
| --- | --- | --- |
| `rename-table` | `entries: [{from, to, expect}]` | Literal string substitution across all upstream-derived text. `expect` is the required number of occurrences; a mismatch is a build error. |
| `replace-section` | `section`, `patch` | Replace a whole section — the heading line plus everything up to the next heading of the same or higher level — with the patch file's contents. |
| `insert-after-section` | `section`, `patch` | Insert the patch file's contents immediately after that section. |
| `replace-text` | `patch` | Apply surgical find/replace blocks from the patch file (format in §4.4). |
| `append` | `patch` | Append the patch file's contents at the end of the document. |
| `prepend` | `patch` | Insert the patch file's contents at the very top of the document. |

### 4.3 Execution model

1. The builder loads `../SPEC.md` as a single **mutable region**.
2. Ops execute **in document order** — top to bottom through `DELTA.md`, and in listed order inside
   a section.
3. Text introduced by a patch file becomes a **frozen region**. Frozen regions are never touched by
   later ops' anchors or renames.
4. Because patch text is frozen, patch files are written in *fork* terminology and may legitimately
   mention `codex` (for example, when documenting the legacy-config compatibility shim) without a
   later rename op mangling them.
5. `rename-table` applies only to mutable regions, and `expect` counts only mutable regions.

This makes the build a pure function: same upstream + same delta ⇒ byte-identical `SPEC.md`.

### 4.4 Patch file format

`replace-section`, `insert-after-section`, `append` and `prepend` patches are plain Markdown — the
file contents are used verbatim.

`replace-text` patches contain one or more conflict-marker blocks:

```text
<<<<<<< FIND
exact upstream text, including indentation
=======
fork replacement text
>>>>>>> REPLACE
```

Rules:

- Each `FIND` body MUST match the current document **exactly once**. Zero matches or multiple
  matches are build errors naming the delta ID and patch file.
- Blocks in one file apply top to bottom.
- A `FIND` body may span multiple lines; leading and trailing newlines inside the block are
  significant.

### 4.5 Delta markers

Every patch file MUST contain at least one marker comment naming its own delta ID:

```html
<!-- delta: D-003 -->
```

Markers are HTML comments, so they are invisible in rendered Markdown but greppable in the generated
`SPEC.md`. `spec:check` enforces the correspondence in both directions:

- every `D-NNN` section in `DELTA.md` that owns a patch file has its marker present in that patch;
- every `<!-- delta: D-NNN -->` marker found in `SPEC.md` resolves to a section in `DELTA.md`.

So a reader of the generated fork spec can always ask "why does this paragraph exist?" and get an
answer by grepping the marker in `DELTA.md`.

### 4.6 Writing style for delta prose

Delta prose is read by humans *and* by coding agents doing an upstream merge. Keep it:

- **Natural** — full sentences, no diff jargon beyond the op names.
- **Compact** — a change gets a paragraph, not a page. If it needs a page, the page belongs in the
  patch file (which becomes spec text), not in the delta description.
- **Deterministic** — state *what* changed and *what it changed to*, not *why it might be nice*.
  A reader must be able to predict the generated text from the description.
- **Self-contained** — never say "see the code". The delta must stand alone if the implementation is
  rewritten in another language.

Each section SHOULD carry a one-line `Upstream anchor:` note identifying the upstream sections it
touches, so an upstream diff can be routed to delta IDs by section number alone.

## 5. Invariants

These hold for every commit. `spec:check` enforces I1–I5 mechanically; I6–I8 are review rules.

- **I1 — Generated output is committed.** `SPEC.md` is committed and equals a fresh build.
- **I2 — Upstream is pinned.** `upstream.lock.json.upstream_sha256` equals the SHA-256 of
  `../SPEC.md`.
- **I3 — Every anchor resolves.** No op may match zero times or ambiguously.
- **I4 — Rename counts are exact.** Every `rename-table` entry's `expect` matches reality.
- **I5 — Markers round-trip.** Delta IDs in `SPEC.md` and `DELTA.md` are in bijection (§4.5).
- **I6 — Upstream section numbering is preserved.** Fork-only material is added as new
  sub-sections at the end of an existing section, or as a new appendix — never by renumbering
  upstream sections. This keeps upstream diffs routable by section number forever.
- **I7 — No silent semantic drift.** Any behavior difference from upstream has a delta ID. If you
  find forked text you cannot attribute to a delta ID, that is a bug in the delta, not in the spec.
- **I8 — The fork stays a superset where it can.** Where upstream mandates Codex-specific behavior,
  the fork generalizes it *and* keeps the Codex behavior reachable as one adapter, so a
  conforming upstream deployment can be reproduced by configuration alone.

## 6. Upstream sync procedure

Run this whenever `../SPEC.md` changes — after pulling upstream, or when `spec:check` reports
`upstream_drift`.

### Step 0 — Confirm the drift

```sh
bun run spec:check
```

An `upstream_drift` failure prints the old and new SHA-256. Nothing else in the procedure matters
until this is the reported failure; other failures mean the fork is internally inconsistent and
must be fixed first.

### Step 1 — Get the upstream diff

```sh
git log --oneline <last-synced-commit>..HEAD -- SPEC.md
git diff <last-synced-commit>..HEAD -- SPEC.md
```

`<last-synced-commit>` is `upstream.lock.json.upstream_commit`.

### Step 2 — Classify every hunk

Put each hunk into exactly one of four buckets.

| Bucket | Test | Action |
| --- | --- | --- |
| **A. Untouched** | The hunk edits text no delta op anchors on, and introduces no agent-runtime coupling. | Nothing to do. The rebuild absorbs it automatically. |
| **B. Anchored** | The hunk edits text that a `FIND` body, `section:` heading, or rename `from:` string depends on. | Update that delta's anchor to the new upstream text, keeping the fork's intent. Note the change in the delta prose if the meaning shifted. |
| **C. New coupling** | The hunk adds new Codex/app-server-specific behavior, config, fields, or tests. | Extend the fork: either widen an existing delta or add a new `D-NNN`. See §6.1. |
| **D. Conflicting intent** | The hunk changes a rule the fork deliberately replaced (for example, upstream restructures section 10). | Rewrite the owning delta's patch against the new upstream text. Prefer keeping the fork's section numbering identical to upstream's new numbering (I6). |

Bucket B and D failures surface on their own during Step 3 — the build names the delta ID. Bucket C
is the one that needs human judgement, because a clean build does **not** prove the fork is still
agent-agnostic.

### Step 2b — Bucket C detection

After the rebuild, scan the generated fork spec for reintroduced coupling:

```sh
grep -niE 'codex|app-server|app_server' agent-agnostic/SPEC.md
```

Every surviving hit MUST be one of:

- inside a passage that deliberately documents the `codex-app-server` adapter or the legacy `codex:`
  config shim (these are expected and are marked with their delta ID), or
- a new upstream addition that needs a bucket-C delta.

If a hit is neither, it is new coupling that leaked through. Write the delta.

### Step 3 — Rebuild

```sh
bun run spec:build
```

Fix every reported error before continuing. Errors name the delta ID and patch file.

### Step 4 — Re-check the implementation

An upstream change can be spec-clean but implementation-breaking. Check, in order:

1. `bun test` — the suite includes conformance tests keyed to the forked spec's sections.
2. New or changed **REQUIRED** behavior in upstream §17/§18 — mirrored into `test/`.
3. New config keys — added to `src/config/schema.ts` with defaults, and to the cheat-sheet delta if
   the fork renamed neighbouring keys.
4. New agent-runtime capability implied by upstream — added to the capability set in the forked §10
   and to `AgentCapabilities` in `src/agent/types.ts`, with a documented fallback for adapters that
   lack it.

### Step 5 — Record the sync

`spec:build` rewrites `upstream.lock.json` with the new hash and the current upstream commit. Commit
`SPEC.md`, `upstream.lock.json`, and any `DELTA.md`/`patches/` edits in a single commit whose message
names the upstream commit range that was absorbed.

### 6.1 Choosing between widening a delta and adding one

Widen an existing `D-NNN` when the upstream addition is the *same kind* of coupling the delta already
removes (for example, upstream adds another `codex.*` config field — that belongs to the config
delta). Add a new `D-NNN` when upstream introduces a *new axis* of coupling (for example, upstream
adds a Codex-specific caching protocol). New IDs are allocated by incrementing the highest existing
number; IDs are never reused or renumbered, even when a delta is retired.

Retiring a delta: keep its section, set `Status: retired` in its prose, delete its ops, and say in
one sentence which upstream change made it unnecessary. Retired IDs stay in the file as history.

## 7. Relationship between the spec fork and the implementation

`src/` implements the **forked** spec, not upstream's. When the two disagree, the forked `SPEC.md`
wins.

The implementation is expected to be a conforming implementation in the sense of forked §17/§18,
including:

- the agent adapter registry (forked §10) with at least the `codex-app-server`, `claude-code`, and
  `cli-exec` adapters (forked Appendix B);
- the tracker adapter registry (§11), unchanged in contract from upstream.

Adding an agent adapter never requires touching the orchestrator. If it does, the abstraction in
forked §10 is wrong and the fix belongs in the delta, not in a special case in `src/orchestrator/`.
