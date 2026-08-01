<!-- delta: D-006 -->

#### 5.3.6 `runner` (object)

`runner` selects and configures the coding agent. It is the agent-side mirror of `tracker`: a
`kind` that names one adapter, plus an adapter-owned `provider` object the core never interprets.

Core fields:

- `kind` (string)
  - REQUIRED for dispatch.
  - Selects one implementation-supported agent adapter (Section 10.1).
- `command` (string shell command)
  - Default: adapter-defined.
  - The launch command for adapters that start a local subprocess.
  - The runtime launches this command through a local shell in the workspace directory, using the
    same shell contract as workspace hooks (Section 9.4).
  - Adapters that do not launch a subprocess MUST document that they ignore this field.
- `provider` (object)
  - Default: `{}`.
  - Adapter-owned configuration: model selection, approval and sandbox policy, endpoints,
    credentials, protocol options, and anything else specific to one coding agent.
  - Core Symphony MUST preserve unknown keys verbatim and MUST NOT prescribe a cross-agent schema
    for them.
  - Each adapter MUST document its keys, defaults, secret keys, `$VAR_NAME` support, and validation
    errors, exactly as tracker adapters do for `tracker.provider`.
  - If a documented secret `$VAR_NAME` resolves to an empty string, treat that secret as missing.
- `env` (map `string -> string`)
  - Default: `{}`.
  - Extra environment variables for the agent child process, resolved through the same `$VAR_NAME`
    indirection as other config values.
  - This is the supported way to hand agent-runtime credentials to the child. It does not affect
    tracker credentials, which stay host-side (Section 15.3).
- `require_client_tools` (boolean)
  - Default: `false`.
  - When `true`, dispatch preflight fails if the selected adapter declares
    `client_tools=false` (Section 10.3). Use it when the workflow's tracker writes depend on
    host-executed tools and a silent downgrade would be worse than not running.
- `turn_timeout_ms` (integer)
  - Default: `3600000` (1 hour)
  - Maximum silence interval while a turn is active; every adapter-emitted event resets it. It is
    not a total turn runtime cap.
- `read_timeout_ms` (integer)
  - Default: `5000`
  - Request/response timeout for adapter-level synchronous exchanges such as session startup.
- `stall_timeout_ms` (integer)
  - Default: `300000` (5 minutes)
  - Enforced by the orchestrator based on event inactivity.
  - If `<= 0`, stall detection is disabled.

Timeout fields are core because the orchestrator enforces them. Everything that varies per coding
agent lives in `provider`.

Deprecated `codex` compatibility alias:

Upstream Symphony spells this block `codex`. To keep upstream `WORKFLOW.md` files working
unchanged, an implementation MUST accept the legacy block and normalize it before validation:

- If `runner` is absent and `codex` is present, synthesize:
  - `runner.kind = "codex-app-server"`
  - `runner.command = codex.command` (default `codex app-server`)
  - `runner.turn_timeout_ms`, `runner.read_timeout_ms`, `runner.stall_timeout_ms` from the
    same-named `codex` fields
  - `runner.provider` = every remaining `codex` key verbatim, which carries `approval_policy`,
    `thread_sandbox`, and `turn_sandbox_policy` through to the Codex adapter unchanged
- If both `runner` and `codex` are present, `runner` wins entirely; the implementation MUST emit an
  operator-visible deprecation warning and MUST NOT merge the two blocks.
- If neither is present, `runner.kind` is missing and dispatch preflight fails (Section 6.3).

The alias is a translation, not a second code path: after normalization the rest of the service sees
only `runner`.

