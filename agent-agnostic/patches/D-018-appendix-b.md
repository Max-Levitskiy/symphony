
<!-- delta: D-018 -->

## Appendix B. Reference Agent Adapter Profiles

These are the adapter profiles the reference implementation ships, published in the form Section
10.10 requires. They are normative as examples of the profile format and as the behavior of these
specific `runner.kind` values; an implementation is free to ship a different set.

Capability shorthand used below, in fixed order:

`session_continuation / streaming_events / client_tools / approvals / cancellation / usage_reporting / rate_limit_reporting`

### B.1 `codex-app-server`

Reproduces upstream Symphony's behavior exactly. Selecting this adapter and using the legacy
`codex` config block yields an upstream-equivalent deployment.

- Runtime: Codex CLI in app-server mode. Protocol schemas come from the installed Codex version;
  inspect them with `codex app-server generate-json-schema --out <dir>` and read the definitions
  referenced by `v2/ThreadStartParams.json` and `v2/TurnStartParams.json`.
- Default `runner.command`: `codex app-server`
- Transport: newline-delimited JSON-RPC over the subprocess's stdio, stderr kept separate.
- Capabilities: `true / true / true / true / true / true / true`
- `runner.provider` keys, all passed through to Codex without local interpretation:
  - `approval_policy` — Codex `AskForApproval` value
  - `thread_sandbox` — Codex `SandboxMode` value
  - `turn_sandbox_policy` — Codex `SandboxPolicy` value
  - any other key — forwarded verbatim to the corresponding thread/turn start parameter
- Secrets: none of its own; Codex authenticates out of band. `runner.env` MAY carry
  provider credentials.
- Event mapping: `turn/completed` -> `turn_completed`; `turn/failed` -> `turn_failed`;
  `turn/cancelled` -> `turn_cancelled`; approval requests -> `approval_requested` then
  `approval_resolved`; dynamic tool calls -> `tool_call_completed` / `tool_call_failed` /
  `unsupported_tool_call`; `thread/tokenUsage/updated` -> `usage_updated` with
  `mode=cumulative`; user-input requests -> `turn_input_required`; everything else ->
  `notification`.
- Usage mode: `cumulative`. Absolute thread totals are reported; delta-shaped payloads such as
  `last_token_usage` are ignored.
- Approval posture: whatever `approval_policy` and the sandbox fields configure. The adapter
  auto-resolves approval requests according to the implementation's documented policy.

### B.2 `claude-code`

- Runtime: Claude Code CLI in headless streaming mode.
- Default `runner.command`:
  `claude -p --output-format stream-json --input-format stream-json --verbose`
- Transport: newline-delimited JSON over the subprocess's stdio. Turn input is written as a
  stream-json user message; the turn ends on the runtime's terminal result message.
- Capabilities: `true / true / false / false / true / true / false`
- `runner.provider` keys:
  - `model` — model identifier passed to the CLI
  - `permission_mode` — CLI permission mode; the adapter's non-blocking default is documented in
    the implementation
  - `allowed_tools` / `disallowed_tools` — tool allow/deny lists
  - `mcp_config` — path to an MCP configuration file
  - `extra_args` — additional argv appended verbatim
- Secrets: `ANTHROPIC_API_KEY` when the CLI is not already authenticated. Supply it through
  `runner.env` with `$VAR` indirection; the adapter declares it in
  `sensitive_environment_names()`.
- `approvals=false` rationale: the adapter runs the CLI in a mode that never blocks on an
  interactive approval, so approval signals cannot arrive. Access control is expressed with the
  tool allow/deny lists and external sandboxing, not with per-action approvals.
- `client_tools=false` rationale: the CLI reaches host-provided tools through MCP servers rather
  than an inline tool protocol, and this adapter does not host an MCP bridge. Declaring `true` and
  then ignoring advertised tools would be a conformance failure (Section 10.3), so it declares
  `false` and the orchestrator takes the documented fallback. Point `mcp_config` at a tracker MCP
  server to give the agent tracker writes another way, or set `runner.require_client_tools: true`
  to refuse this adapter outright. An adapter that gains an MCP bridge flips the capability; no
  orchestrator change is involved.
- `rate_limit_reporting=false` rationale: the streaming output carries no rate-limit snapshot.
- Event mapping: assistant/tool-progress messages -> `notification`; usage-bearing messages ->
  `usage_updated` with `mode=cumulative`; the terminal result message -> `turn_completed` or
  `turn_failed` by its error flag; a non-zero process exit mid-turn -> `turn_failed` with category
  `agent_exit`.
- Usage mode: `cumulative`.

### B.3 `cli-exec`

The generic escape hatch. Drives any coding agent that has a non-interactive mode: run a command,
give it a prompt, look at the exit code. It exists so that "agent-agnostic" is demonstrable rather
than aspirational — an agent with no streaming protocol, no session model, and no telemetry is still
orchestrable.

- Runtime: any command.
- Default `runner.command`: none; `runner.command` is REQUIRED.
- Transport: none. The prompt is delivered on stdin, or substituted into the command when
  `prompt_arg_placeholder` is configured. Exit code `0` is `completed`; any other exit code is
  `failed`.
- Capabilities: `false / false / false / false / false / false / false`
- `runner.provider` keys:
  - `prompt_delivery` — `stdin` (default) or `argv`
  - `prompt_arg_placeholder` — token replaced by the prompt when `prompt_delivery: argv`
    (default `{{prompt}}`)
  - `success_exit_codes` — list of integers treated as success (default `[0]`)
  - `capture_output_bytes` — maximum stdout/stderr retained for the turn message (default `65536`)
- Secrets: none of its own; use `runner.env`.
- Every capability is `false`, which exercises every fallback in Section 10.3 at once:
  - each turn resends the full rendered prompt, because the command retains nothing;
  - `session_key` is generated once per worker run and reused across turns, so logs stay correlated
    even though each turn is a separate process;
  - the only events are `session_started` and one terminal turn event, so `stall_timeout_ms` caps
    whole-turn wall-clock time;
  - no tools are advertised and `client_tools_unavailable` is emitted once;
  - `stop_session` terminates any in-flight process;
  - token counters stay `0` with `usage_reported=false`.
- Workspace confinement: the command is launched with the workspace as its working directory. The
  adapter cannot confine an agent that chooses to write elsewhere, so deployments using it SHOULD
  add external isolation (Section 15.5).

### B.4 Writing a new adapter

A new adapter is conforming when it:

1. registers a unique `runner.kind`;
2. declares all seven capabilities explicitly, with a stated reason for each `false`;
3. maps every native signal onto the Section 10.6 vocabulary, using `notification` or
   `other_message` for signals with no equivalent;
4. maps native errors onto the Section 10.8 categories;
5. produces a stable non-empty `session_key` for the whole worker run;
6. confines the agent's working directory to the per-issue workspace (Section 9.5);
7. publishes the profile required by Section 10.10;
8. passes the capability-fallback tests in Section 17.5 for every capability it declares `false`.

Nothing in that list requires a change to the orchestrator. If an adapter cannot be added without
one, the abstraction in Section 10 is wrong and this specification is what needs to change.
