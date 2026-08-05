# Local demo

A complete Symphony run on your machine in about ten seconds, with no tracker account, no API key,
and no coding agent installed.

It uses the `memory` tracker (a JSON file of issues) and the `cli-exec` agent adapter driving
`fake-agent.sh` — a twelve-line shell script that reads a prompt on stdin, writes a file, and moves
its own issue to `Done` after its second turn.

That combination is the point. `cli-exec` declares **every capability false**: no session
continuation, no streaming events, no client tools, no approvals, no cancellation, no usage
reporting, no rate limits. If the orchestrator can drive that to completion through the same code
path it uses for a full-capability agent, the section 10 boundary is real.

## Run it

```sh
cd agent-agnostic/examples/local-demo
export DEMO_DIR=$(pwd)
bun run ../../src/cli.ts ./WORKFLOW.md
```

Leave it running and look at `http://127.0.0.1:4477`, or:

```sh
curl -s http://127.0.0.1:4477/api/v1/state | jq
curl -s http://127.0.0.1:4477/api/v1/DEMO-1 | jq
curl -s -X POST http://127.0.0.1:4477/api/v1/refresh
```

Stop with Ctrl-C, then `./reset.sh` to run it again.

## What you should see

```text
msg="orchestrator started"  tracker_kind=memory agent_kind=cli-exec poll_interval_ms=2000
msg="dispatching issue"     issue_id=i1 issue_identifier=DEMO-1 attempt=0 state=Todo
msg="dispatching issue"     issue_id=i2 issue_identifier=DEMO-2 attempt=0 state=Todo
msg="worker completed"      issue_id=i1 issue_identifier=DEMO-1
msg="workspace removed"     workspace=.../workspaces/DEMO-1
```

Both issues end at `Done` in `issues.json`, and their workspaces are gone — reconciliation cleans up
on a terminal transition.

`DEMO-1` is dispatched before `DEMO-2` despite being listed first by coincidence: it has
`priority: 1` against `priority: 3`, which is the sort order in spec 8.2.

## Seeing the capability fallback

Workspaces are deleted when an issue reaches a terminal state, which makes the agent's transcript
hard to inspect. To keep them, run the variant where `Done` is *not* terminal — the issue then
leaves the active set, which stops the run without cleanup:

```sh
sed 's/terminal_states: \[Done, Cancelled\]/terminal_states: [Cancelled]/' WORKFLOW.md > WORKFLOW.persist.md
./reset.sh && bun run ../../src/cli.ts ./WORKFLOW.persist.md
# Ctrl-C after a few seconds
cat workspaces/DEMO-1/work.log
```

`work.log` records the exact prompt the agent received each turn. Turn 1 is the rendered task. Turn
2 is **the whole task again, plus continuation guidance**:

```text
===== turn 18:20:27 =====
You are working on DEMO-1: Add a changelog entry
...
===== turn 18:20:27 =====
You are working on DEMO-1: Add a changelog entry
...
---

Continue the work you were doing on this issue.

- The issue is still in an active state, so it is not finished.
- Resume from the current workspace state; do not restart from scratch.
...
This is turn 2 of at most 5.
```

That is the `session_continuation: false` fallback (spec 7.1, delta D-008). A `codex-app-server`
session would receive the guidance *alone* on turn 2, because the task is already in its thread
history. Neither the workflow nor the orchestrator chose that — the adapter's declared capability
did, and multi-turn work still progresses either way because the **workspace** carries state
between turns, not the agent's memory.

## Try switching agents

Replace the `runner` block with a real coding agent and change nothing else:

```yaml
runner:
  kind: codex-app-server
  command: codex app-server
  provider:
    approval_policy: never
    thread_sandbox: workspace-write
```

or

```yaml
runner:
  kind: claude-code
  provider:
    model: claude-opus-4-5
  env:
    ANTHROPIC_API_KEY: $ANTHROPIC_API_KEY
```

The prompt, the tracker, the workspace layout, the retry behavior, and the dashboard are unchanged.
That is the whole claim of this fork, and it is one config block wide.
