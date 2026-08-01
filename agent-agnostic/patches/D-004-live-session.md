<!-- delta: D-004 -->

#### 4.1.6 Live Session (Agent Session Metadata)

State tracked while a coding-agent session is running.

Fields:

- `agent_kind` (string)
  - The `runner.kind` of the adapter that owns this session. Recorded per session, because a
    workflow reload can change the configured adapter while a session is still running.
- `session_id` (string, `<session_key>-<turn_key>`)
- `session_key` (string)
  - Adapter-supplied identity for the agent-side session, thread, or conversation. Opaque to the
    orchestrator.
- `turn_key` (string)
  - Adapter-supplied identity for the current turn. Opaque to the orchestrator.
- `agent_process_pid` (string or null)
  - Present when the adapter launches a local subprocess; `null` otherwise.
- `last_agent_event` (string/enum or null)
- `last_agent_timestamp` (timestamp or null)
- `last_agent_message` (summarized payload)
- `agent_input_tokens` (integer)
- `agent_output_tokens` (integer)
- `agent_total_tokens` (integer)
- `last_reported_input_tokens` (integer)
- `last_reported_output_tokens` (integer)
- `last_reported_total_tokens` (integer)
- `usage_reported` (boolean)
  - `false` when the selected adapter declares `usage_reporting=false` (Section 10.3). The token
    counters then stay at `0` and consumers MUST present them as "not reported" rather than as
    measured zero usage.
- `turn_count` (integer)
  - Number of agent turns started within the current worker lifetime.

