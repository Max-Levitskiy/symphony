<<<<<<< FIND
- Workflow file can be loaded and parsed.
- `tracker.kind` is present and supported.
- The selected adapter accepts `tracker.provider` after documented defaults and `$VAR`
  resolution.
- `codex.command` is present and non-empty.
=======
<!-- delta: D-007 -->
- Workflow file can be loaded and parsed.
- `tracker.kind` is present and supported.
- The selected adapter accepts `tracker.provider` after documented defaults and `$VAR`
  resolution.
- `runner.kind` is present (after the legacy `codex` normalization in Section 5.3.6) and resolves
  to a registered agent adapter.
- The selected agent adapter accepts `runner` after documented defaults and `$VAR` resolution. For
  an adapter that launches a subprocess this includes a non-empty effective `runner.command`.
- If `runner.require_client_tools` is `true`, the selected agent adapter declares
  `client_tools=true`.
>>>>>>> REPLACE
<<<<<<< FIND
- `codex.command`: shell command string, default `codex app-server`
- `codex.approval_policy`: Codex `AskForApproval` value, default implementation-defined
- `codex.thread_sandbox`: Codex `SandboxMode` value, default implementation-defined
- `codex.turn_sandbox_policy`: Codex `SandboxPolicy` value, default implementation-defined
- `codex.turn_timeout_ms`: integer, default `3600000`
- `codex.read_timeout_ms`: integer, default `5000`
- `codex.stall_timeout_ms`: integer, default `300000`
=======
<!-- delta: D-007 -->
- `runner.kind`: string, REQUIRED, selects one registered agent adapter
- `runner.command`: shell command string, adapter-defined default, ignored by adapters that do not
  launch a subprocess
- `runner.provider`: object, default `{}`, adapter-owned model/policy/endpoint/auth settings
- `runner.env`: map of strings, default `{}`, extra environment for the agent child process
- `runner.require_client_tools`: boolean, default `false`
- `runner.turn_timeout_ms`: integer, default `3600000`
- `runner.read_timeout_ms`: integer, default `5000`
- `runner.stall_timeout_ms`: integer, default `300000`
- `codex.*`: deprecated; normalized into `runner` per Section 5.3.6
>>>>>>> REPLACE
