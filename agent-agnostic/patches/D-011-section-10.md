<!-- delta: D-011 -->

## 10. Agent Runtime Integration Contract

This section replaces upstream's Codex app-server protocol section. It defines a portable boundary
between the orchestrator and *one* coding agent, in the same shape Section 11 defines for issue
trackers: a small required read/execute kernel, an explicit capability declaration, and a normalized
vocabulary the orchestrator understands.

The boundary exists to make one statement true:

> The orchestrator MUST NOT contain code that is specific to any coding agent. Everything
> agent-specific — transport, framing, method names, message schemas, approval semantics, sandbox
> configuration, usage payload shapes — lives inside one agent adapter.

Protocol source of truth:

- An adapter's native protocol is defined by the coding agent it targets, not by this document.
  This specification never describes a wire format.
- An adapter MUST send messages that are valid for the runtime version it targets, and MUST document
  which versions it targets.
- Where this specification and a targeted runtime protocol appear to conflict, the runtime protocol
  controls protocol shape and transport; this section controls orchestration behavior, workspace
  selection, prompt construction, continuation handling, capability fallback, and observability
  extraction.

### 10.1 Adapter Selection and Registry

- An implementation maintains an `agent adapter registry` mapping `runner.kind` values to adapters.
- `runner.kind` selects exactly one adapter for a dispatch. An unknown value is a dispatch preflight
  failure (`unsupported_agent_kind`), not a runtime failure.
- Adapter selection, the effective `runner` config, and the resulting capability set MUST be bound
  to one session snapshot at session start. A workflow reload applies to future sessions; it MUST
  NOT change the adapter, capabilities, or policy of a session already running.
- An implementation MUST register at least one adapter to be useful, and SHOULD register more than
  one so the boundary is exercised rather than assumed.
- Adapters MUST NOT be selected implicitly by probing the host for installed executables. Selection
  is configuration, so a deployment is reproducible.

### 10.2 REQUIRED Adapter Operations

An implementation MUST support these adapter operations. Signatures are language-neutral; an
implementation MAY express them as an interface, a module contract, a record of closures, or any
equivalent construct.

```text
capabilities() -> Capabilities
validate_config(runner_config) -> ok | error{category, message}
sensitive_environment_names() -> list<string>
start_session(params) -> ok(Session) | error{category, message}
run_turn(session, turn_input, on_event) -> ok(TurnOutcome) | error{category, message}
stop_session(session) -> ok | error{category, message}
```

`start_session` parameters:

- `workspace_path` (absolute per-issue workspace path; the session's working directory)
- `issue` (normalized issue from Section 4.1.1, for titles and adapter-side context)
- `runner_config` (effective `runner` object after defaults and `$VAR` resolution)
- `tools` (list of client-side tool specs to advertise; empty when unsupported or unused)
- `execute_tool(name, arguments) -> ToolResult` (host-side callback; see Section 10.7)
- `on_event(event)` (normalized event sink; see Section 10.6)
- `environment` (resolved child environment, already stripped of tracker secrets)

`Session` MUST expose at least:

- `session_key` (Section 4.2)
- `agent_process_pid` (string or null)
- `capabilities` (the snapshot bound at start; see Section 10.1)

`turn_input`:

- `turn_number` (1-based within the current worker lifetime)
- `kind` (`initial` or `continuation`)
- `text` (the rendered prompt for this turn, already resolved per Section 7.1 continuation rules)
- `title` (OPTIONAL display title, for example `<issue.identifier>: <issue.title>`)

`TurnOutcome`:

- `status` (one of `completed`, `failed`, `cancelled`, `timed_out`, `input_required`)
- `turn_key` (Section 4.2)
- `error_category` (string or null; RECOMMENDED categories in Section 10.8)
- `message` (string or null, human-readable, secret-free)

Only `completed` is a success. The worker treats every other status as a failed attempt and lets the
orchestrator apply the retry rules in Section 8.4.

### 10.3 Capability Declaration and REQUIRED Fallbacks

Coding agents differ. The orchestrator adapts to those differences through a declared capability
set, never by inspecting `runner.kind`. Every capability is a boolean and MUST be declared
explicitly; there is no default.

```text
Capabilities = {
  session_continuation:  boolean,
  streaming_events:      boolean,
  client_tools:          boolean,
  approvals:             boolean,
  cancellation:          boolean,
  usage_reporting:       boolean,
  rate_limit_reporting:  boolean
}
```

Each capability has a REQUIRED fallback when it is `false`. The fallback is normative: an
implementation MUST behave as described rather than failing or improvising.

- `session_continuation` — the runtime keeps conversation state across turns in one session.
  - `false`: the worker MUST send the full rendered task prompt on every turn (Section 7.1), and
    the adapter MAY internally start a fresh runtime invocation per turn. Multi-turn work still
    functions because the workspace, not the agent's memory, carries state between turns.
- `streaming_events` — the runtime emits progress events while a turn is in flight.
  - `false`: the adapter MUST still emit `session_started` and exactly one terminal turn event per
    turn. Stall detection then measures whole-turn elapsed time (Section 8.5).
- `client_tools` — the runtime can call host-provided tools during a turn.
  - `false`: the runtime MUST NOT advertise tools, MUST emit one `client_tools_unavailable` event
    per session, and MUST continue. Tracker writes then depend on whatever the workflow policy layer
    arranges out of band. Dispatch fails instead only when `runner.require_client_tools` is `true`
    (Section 6.3).
- `approvals` — the runtime asks the client to approve commands or file changes.
  - `false`: the adapter MUST launch the runtime in a mode that never blocks on approval, and MUST
    document that mode in its profile. The orchestrator MUST NOT synthesize approvals.
- `cancellation` — the runtime supports cooperative cancellation of an in-flight turn.
  - `false`: `stop_session` and reconciliation-driven termination MUST terminate the underlying
    process or connection. Termination is still REQUIRED to be prompt; losing partial work is
    acceptable, hanging is not.
- `usage_reporting` — the runtime reports token usage.
  - `false`: token counters remain `0`, `usage_reported` is `false` on the live session, and
    observability consumers MUST render "not reported" rather than zero (Section 13.5).
- `rate_limit_reporting` — the runtime reports provider rate-limit state.
  - `false`: the rate-limit snapshot stays `null`.

Capability rules:

- Capabilities are static per adapter, or derived from `runner.provider` at `start_session` time.
  They MUST NOT change during a session.
- An adapter MUST NOT declare a capability it cannot honor. Declaring `client_tools=true` and then
  ignoring advertised tools is a conformance failure, not a degraded mode.
- Adding a capability to this list is a specification change. Adapters MUST reject an unknown
  capability key rather than silently ignoring it, so a newer orchestrator never assumes support
  from an older adapter.

### 10.4 Session Startup Responsibilities

Startup follows the targeted runtime's own contract. Symphony additionally requires the adapter to:

- Start the session with the absolute per-issue workspace path as the working directory, and refuse
  to start if that path is not the workspace path (Section 9.5).
- Apply `runner.env` on top of the inherited environment for any child process it launches.
- Apply the implementation's documented approval and sandbox posture using whatever mechanism the
  targeted runtime provides, or declare `approvals=false` and run in a non-blocking mode.
- Advertise the supplied client-side tool specs when `client_tools=true`.
- Produce a non-empty `session_key`.
- Emit `session_started` once, or `startup_failed` with a category from Section 10.8.
- Include issue-identifying metadata such as `<issue.identifier>: <issue.title>` wherever the
  targeted runtime accepts a session or turn title.

Startup MUST NOT require the orchestrator to know anything about the runtime's handshake. If a
runtime needs a multi-step handshake, capability negotiation, or authentication exchange, that is
entirely inside `start_session`.

### 10.5 Turn Execution and Completion

The adapter runs one turn per `run_turn` call and returns exactly one `TurnOutcome`.

Completion mapping:

- runtime turn completion -> `completed`
- runtime turn failure -> `failed`
- runtime turn cancellation -> `cancelled`
- no adapter event for `runner.turn_timeout_ms` while a turn is active -> `timed_out`
- underlying process or connection ends mid-turn -> `failed` with category `agent_exit`
- runtime requests user input and the implementation's documented policy does not satisfy it ->
  `input_required`

Continuation processing:

- When `session_continuation=true`, the same session MUST stay alive across continuation turns and
  be stopped only when the worker run ends.
- When `session_continuation=false`, the adapter MAY tear down and re-create runtime state between
  turns. The orchestrator does not observe the difference: `session_key` MUST remain stable for the
  whole worker run either way, so logs and snapshots stay correlated.

Transport handling:

- Follow the transport and framing rules of the targeted runtime.
- For stdio-based transports, keep the protocol stream separate from diagnostic stderr unless the
  targeted protocol specifies otherwise, and bound line buffering (10 MB is a RECOMMENDED maximum
  line size).

### 10.6 Normalized Runtime Events

The adapter emits normalized events to the orchestrator callback. This vocabulary is the entire
observability contract; the orchestrator never parses a native payload.

Each event SHOULD include:

- `event` (enum/string from the list below)
- `timestamp` (UTC timestamp)
- `agent_kind` (the selected `runner.kind`)
- `agent_process_pid` (if available)
- OPTIONAL `usage` object: `{input_tokens, output_tokens, total_tokens, mode}` where `mode` is
  `cumulative` or `incremental` (Section 13.5)
- OPTIONAL `rate_limits` object (adapter-owned shape, treated as opaque display data)
- OPTIONAL `message` (short, human-readable, secret-free summary)
- OPTIONAL `native` (raw payload retained for debugging; implementations SHOULD truncate it and
  MUST NOT let orchestrator logic depend on it)

Normalized event names:

- `session_started`
- `startup_failed`
- `turn_started`
- `turn_completed`
- `turn_failed`
- `turn_cancelled`
- `turn_timed_out`
- `turn_input_required`
- `approval_requested`
- `approval_resolved`
- `tool_call_completed`
- `tool_call_failed`
- `unsupported_tool_call`
- `client_tools_unavailable`
- `usage_updated`
- `rate_limits_updated`
- `notification`
- `other_message`
- `malformed`

An adapter MUST map every native signal it cares about onto exactly one of these names, and MUST use
`notification` or `other_message` for native signals with no normalized equivalent rather than
inventing a name. Orchestrator logic MUST depend only on this list.

### 10.7 Approval, Tool Calls, and User Input Policy

Approval, sandbox, and user-input behavior is implementation-defined, subject to these requirements.

Policy requirements:

- Each implementation MUST document its chosen approval, sandbox, and operator-confirmation posture,
  per adapter, because the available controls differ per runtime.
- Approval requests and user-input-required signals MUST NOT leave a run stalled indefinitely. An
  implementation MAY satisfy them, surface them to an operator, auto-resolve them, or fail the run
  according to its documented policy.
- An adapter that declares `approvals=false` MUST run its runtime in a mode where these signals
  cannot arrive.

Example high-trust behavior:

- Auto-approve command execution approvals for the session.
- Auto-approve file-change approvals for the session.
- Treat user-input-required turns as hard failure.

Client-side tools:

- Client-side tools are the mechanism by which the coding agent performs tracker writes with
  host-held credentials (Section 11.5). They are available only when `client_tools=true`.
- The tools advertised in a session are exactly the selected tracker adapter's
  `agent_tool_specs()`. Tool names, schemas, and result payloads stay adapter-owned; Symphony does
  not standardize a lowest-common-denominator CRUD API.
- The runtime MUST execute advertised tool calls host-side with the active tracker adapter
  configuration and MUST NOT require the coding-agent child process to read raw tracker tokens from
  disk or environment.
- The runtime SHOULD pass the current normalized issue to the tracker adapter as internal execution
  context, so `issue.id` and `issue.native_ref` preserve provider richness without teaching the
  orchestrator provider semantics.
- Tool specs, tracker adapter selection, agent adapter selection, and effective settings MUST be
  bound to one session snapshot (Section 10.1).
- If the agent requests a tool that is not advertised or not supported, the adapter MUST return a
  structured failure result through the targeted protocol, emit `unsupported_tool_call`, and
  continue the session. A session MUST NOT stall on an unsupported tool path.

Minimal language-neutral tracker-adapter hooks for this extension (unchanged from upstream):

```text
agent_tool_specs() -> list<ToolSpec>
secret_environment_names() -> list<string>
execute_agent_tool(name, arguments, context={issue}) -> ToolResult
```

`ToolResult` MUST distinguish success from failure and carry JSON-safe structured output that the
agent adapter can translate into the targeted runtime's tool-result shape. The context contains the
normalized issue, never the credential.

Tracker credentials SHOULD NOT be inherited by the coding-agent child process. A tracker adapter
that resolves credentials from environment variables MUST declare which secret environment names the
launcher removes from local and remote child environments. Literal credentials in a repo-owned
`WORKFLOW.md` remain readable to a child with workspace access and SHOULD NOT be used when this
isolation matters.

User-input-required policy:

- Implementations MUST document how `turn_input_required` outcomes are handled.
- A run MUST NOT stall indefinitely waiting for user input.
- A conforming implementation MAY fail the run, surface the request to an operator, satisfy it
  through an approved operator channel, or auto-resolve it according to its documented policy.

### 10.8 Timeouts and Error Mapping

Timeouts:

- `runner.read_timeout_ms`: request/response timeout during session startup and synchronous adapter
  exchanges
- `runner.turn_timeout_ms`: maximum silence interval while a turn is active; each adapter event
  resets it, so it is not a total turn runtime cap
- `runner.stall_timeout_ms`: enforced by the orchestrator based on event inactivity (Section 8.5)

Error mapping (RECOMMENDED normalized categories):

- `unsupported_agent_kind`
- `invalid_runner_config`
- `missing_agent_secret`
- `agent_runtime_not_found`
- `agent_capability_unsupported`
- `invalid_workspace_cwd`
- `response_timeout`
- `turn_timeout`
- `agent_exit`
- `response_error`
- `turn_failed`
- `turn_cancelled`
- `turn_input_required`

As with tracker adapters (Section 11.4), a literal `{category, message}` object is not required; an
implementation MAY use a language-native tagged error, exception, tuple, or enum as long as its
adapter profile documents the mapping to a stable category and a human-readable message. The
orchestrator relies only on success versus failure and on the category for logging and retry
labeling.

### 10.9 Agent Runner Contract

The `Agent Runner` wraps workspace + prompt + selected agent adapter.

Behavior:

1. Create or reuse the workspace for the issue.
2. Resolve the agent adapter from `runner.kind`; an unresolvable kind fails the attempt with
   `unsupported_agent_kind`.
3. Build the prompt from the workflow template.
4. Start the agent session with the workspace as working directory.
5. Forward normalized adapter events to the orchestrator.
6. Run turns per Section 7.1, choosing continuation prompt content from the
   `session_continuation` capability.
7. Stop the session on exit, then run the `after_run` hook.
8. On any error, fail the worker attempt; the orchestrator decides retry behavior.

Note:

- Workspaces are intentionally preserved after successful runs.
- The runner is the only component allowed to hold an adapter handle. Orchestrator state stores
  normalized session metadata (Section 4.1.6), never an adapter-specific object.

### 10.10 Adapter Profile Publication

Each agent adapter MUST publish a compact profile in implementation documentation, not only in code,
containing:

- the exact supported `runner.kind` value;
- the targeted coding-agent runtime and version range, and how to check the installed version;
- the exact `runner.provider` keys, defaults, secret keys and environment names, and validation
  errors;
- the default `runner.command`, or an explicit statement that the adapter launches no subprocess
  and how it confines file operations to the workspace (Section 9.5);
- the declared capability set and the reason for every `false`;
- the mapping from native protocol signals to the normalized event names in Section 10.6;
- the mapping from native errors to the categories in Section 10.8;
- the approval and sandbox posture the adapter configures, and what it does not control;
- whether usage reports are `cumulative` or `incremental`.

This mirrors the tracker adapter profile requirement in Section 11.2. A capability set without a
published profile is not verifiable, and an unverifiable adapter is not conforming.

