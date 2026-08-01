<!-- delta: D-017 -->

### 17.5 Agent Adapter and Agent Runner

Registry and configuration:

- `runner.kind` selects the matching adapter; an unregistered kind fails dispatch preflight with
  `unsupported_agent_kind` and never reaches a worker
- Adapter selection, effective `runner` config, and the capability snapshot are bound at session
  start and are unaffected by a workflow reload during the session
- `runner.require_client_tools: true` fails preflight against an adapter declaring
  `client_tools=false`

Adapter contract (run against every registered adapter, and against a test double):

- `validate_config` rejects malformed `runner.provider` values with a documented category
- `start_session` uses the per-issue workspace path as the working directory and rejects any other
  path
- `start_session` applies `runner.env` to the child environment and does not leak tracker secrets
  into it
- `start_session` emits exactly one `session_started`, or `startup_failed` with a category
- `session_key` is non-empty and stable for the whole worker run, including for adapters that
  re-create runtime state between turns
- `run_turn` returns exactly one `TurnOutcome` per call and maps runtime completion, failure,
  cancellation, silence timeout, and process exit onto the correct status
- Every emitted event name is drawn from the Section 10.6 vocabulary
- `stop_session` terminates the runtime promptly for adapters declaring `cancellation=false`
- `sensitive_environment_names` values are redacted from logs, snapshots, and error messages

Capability fallbacks (the portability tests that matter most):

- `session_continuation=false`: continuation turns resend the full rendered prompt; multi-turn runs
  still progress; `session_key` stays stable across the re-created runtime state
- `session_continuation=true`: continuation turns send guidance only and never resend the task
  prompt
- `streaming_events=false`: stall detection still terminates a hung turn using
  `runner.stall_timeout_ms`
- `client_tools=false`: no tools are advertised, one `client_tools_unavailable` event is emitted,
  and the session runs to completion
- `usage_reporting=false`: counters stay `0`, `usage_reported` is `false`, and no fabricated totals
  reach the snapshot
- `rate_limit_reporting=false`: the rate-limit snapshot stays `null`

Orchestration integration:

- Request/response read timeout (`runner.read_timeout_ms`) is enforced during startup
- Turn silence timeout (`runner.turn_timeout_ms`) is enforced and produces `timed_out`
- Approvals and user-input requests are handled per the implementation's documented policy and never
  stall indefinitely
- Unsupported dynamic tool calls are rejected without stalling the session
- Usage reports accumulate correctly for both `cumulative` and `incremental` modes across repeated
  reports
- Two adapters with different capability sets produce the same orchestration outcomes for the same
  issue lifecycle, differing only in prompt content and reported telemetry

If provider-native tracker tools are implemented:

- only the selected tracker adapter's tools are advertised to the session
- valid inputs execute host-side with configured adapter auth
- the current normalized issue and `native_ref` are available as internal tool context
- tracker secrets are not inherited by the coding-agent child process
- invalid arguments, missing auth, and transport failures return structured failure payloads
- unsupported tool names still fail without stalling the session

