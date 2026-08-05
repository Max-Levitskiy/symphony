# Symphony, agent-agnostic

An agent-agnostic fork of the [Symphony](../SPEC.md) specification, plus a TypeScript/Bun
implementation of it.

Upstream Symphony orchestrates Codex: the orchestrator speaks the Codex app-server protocol, the
config block is named `codex`, the runtime metrics are named after Codex, and the conformance tests
assert Codex message shapes. This fork keeps every scheduling, workspace, tracker, and observability
rule exactly as upstream wrote it and replaces the one coupling — the coding agent now sits behind an
**agent adapter** selected by `runner.kind`, in the same shape upstream already uses for issue
trackers.

Swapping coding agents is a config edit:

```yaml
runner:
  kind: codex-app-server        # or claude-code, or cli-exec, or one you write
  provider:                     # adapter-owned; the core never interprets it
    approval_policy: never
```

A workflow using upstream's `codex:` block keeps working unchanged — it normalizes to
`runner.kind: codex-app-server`.

## Layout

| Path | What it is |
| --- | --- |
| [`SPEC.md`](SPEC.md) | The forked specification. **Generated** — do not edit by hand. |
| [`DELTA.md`](DELTA.md) | Every difference from upstream, in prose plus executable ops. This is the file you edit. |
| [`RULES.md`](RULES.md) | How the delta works, the invariants, and the upstream sync procedure. |
| `patches/` | Replacement text referenced by `DELTA.md`. |
| `upstream.lock.json` | The upstream SPEC.md hash and commit this fork was built against. |
| `src/` | The implementation. |
| `test/` | Conformance and unit tests, keyed to forked spec sections. |
| `tools/` | The delta engine (`spec:build`, `spec:check`). |
| [`WORKFLOW.example.md`](WORKFLOW.example.md) | An annotated workflow file to copy. |

## Getting started

```sh
bun install
bun test                 # 100 tests, including a real end-to-end subprocess run
bun run spec:check       # verify the fork is consistent with upstream and DELTA.md
bunx tsc --noEmit        # typecheck
```

### See it actually run

[`examples/local-demo/`](examples/local-demo/) is a complete run on your machine in about ten
seconds — no tracker account, no API key, no coding agent installed:

```sh
cd examples/local-demo
export DEMO_DIR=$(pwd)
bun run ../../src/cli.ts ./WORKFLOW.md      # dashboard at http://127.0.0.1:4477
```

Two issues get dispatched in priority order, a twelve-line shell script plays the coding agent, both
issues reach `Done`, and their workspaces are cleaned on the terminal transition. The demo's README
shows how to inspect the exact prompt the agent received each turn, which is where the
`session_continuation: false` fallback becomes visible.

### Run it for real

To run the orchestrator against a repository:

```sh
cp WORKFLOW.example.md /path/to/your/repo/WORKFLOW.md
# edit tracker.provider and runner to taste
bun run start /path/to/your/repo/WORKFLOW.md --port 4000
```

Then open `http://127.0.0.1:4000` for the dashboard, or `GET /api/v1/state` for JSON.

## The design in one section

The whole fork rests on one boundary, defined in forked [SPEC.md §10](SPEC.md):

```text
capabilities()                          -> Capabilities
validate_config(runner)                 -> ok | error
sensitive_environment_names(runner)     -> [string]
start_session(params)                   -> Session | error
run_turn(session, input, on_event)      -> TurnOutcome | error
stop_session(session)                   -> ok | error
```

Coding agents differ, so the orchestrator adapts through a **declared capability set** rather than by
inspecting the adapter's name. Each capability has a normative fallback:

| Capability | What happens when it is `false` |
| --- | --- |
| `session_continuation` | Every turn resends the full rendered prompt. Multi-turn work still progresses, because the *workspace* carries state between turns, not the agent's memory. |
| `streaming_events` | Only session start and one terminal turn event are emitted, so `stall_timeout_ms` becomes a whole-turn wall-clock cap. |
| `client_tools` | No tools are advertised; one `client_tools_unavailable` event is emitted and the run continues. Set `runner.require_client_tools: true` to make that a dispatch failure instead. |
| `approvals` | The adapter must run its runtime in a mode that never blocks. The orchestrator never synthesizes approvals. |
| `cancellation` | `stop_session` terminates the process. Losing partial work is fine; hanging is not. |
| `usage_reporting` | Counters stay `0` and `usage_reported` is `false`, so consumers render "not reported" rather than zero. |
| `rate_limit_reporting` | The rate-limit snapshot stays `null`. |

Declaring a capability you do not honor is a conformance failure, not a degraded mode. The test
suite enforces the fallbacks against a parameterizable adapter double, and asserts that a
full-capability adapter and a zero-capability adapter drive the same issue lifecycle to the same
outcome — differing only in prompt content and telemetry.

## Shipped adapters

| `runner.kind` | Capabilities (`continuation/streaming/tools/approvals/cancel/usage/ratelimit`) |
| --- | --- |
| `codex-app-server` | `true / true / true / true / true / true / true` — upstream-equivalent behavior |
| `claude-code` | `true / true / false / false / true / true / false` |
| `cli-exec` | all `false` — any command with a non-interactive mode |

Profiles are in forked [SPEC.md Appendix B](SPEC.md). A test parses those capability tables out of
the spec and compares them against what the adapters actually declare, so the two cannot drift.

`cli-exec` is the one that matters most: an agent with no session model, no protocol, and no
telemetry is orchestrated to completion by the same code path that drives a full-capability agent.
That is what makes "agent-agnostic" a claim you can run rather than one you have to believe.

## Writing an adapter

Implement `AgentAdapter` from [`src/agent/types.ts`](src/agent/types.ts) and register it:

```ts
import { defaultAgentRegistry } from "./src/agent/registry.ts";

const registry = defaultAgentRegistry().register(myAdapter);
```

The conformance bar is in forked SPEC.md §10.10 and Appendix B.4. The standing test that the
abstraction is right: **adding an adapter must never require an orchestrator change.** A test in
`test/spec-fork.test.ts` enforces the mechanical half of this — no file under `src/` outside an
adapter's own module may name a coding-agent vendor.

## Trackers

The tracker contract is unchanged from upstream. Two adapters ship:

- `memory` — a JSON file of issues, re-read on every fetch. Useful for local runs, for bringing up a
  new agent adapter, and throughout the test suite.
- `github` — one repository's issues, with workflow states carried on `status:` labels. Ships
  provider-native `set_issue_state` and `add_issue_comment` tools that execute host-side with the
  configured credential, so the agent child never sees a token.

## Working on the fork

`SPEC.md` is build output. To change what the forked spec says, edit `DELTA.md` (or a patch file) and
run `bun run spec:build`. `bun run spec:check` — which also runs as a test — fails if the committed
spec was hand-edited, if an anchor stopped matching, if a rename count changed, or if upstream moved
under the fork.

When upstream `../SPEC.md` changes, follow the procedure in [`RULES.md` §6](RULES.md). The short
version: the build tells you which delta IDs broke, and a grep tells you what new coupling snuck in.

## License

Apache 2.0, same as upstream. See [`../LICENSE`](../LICENSE).
