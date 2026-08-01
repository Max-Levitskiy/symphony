<<<<<<< FIND
- For each running issue, compute `elapsed_ms` since:
  - `last_codex_timestamp` if any event has been seen, else
  - `started_at`
- If `elapsed_ms > codex.stall_timeout_ms`, terminate the worker and queue a retry.
- If `stall_timeout_ms <= 0`, skip stall detection entirely.
=======
<!-- delta: D-009 -->
- For each running issue, compute `elapsed_ms` since:
  - `last_agent_timestamp` if any event has been seen, else
  - `started_at`
- If `elapsed_ms > runner.stall_timeout_ms`, terminate the worker and queue a retry.
- If `stall_timeout_ms <= 0`, skip stall detection entirely.
- Stall detection measures event silence, so its meaning depends on the selected adapter's
  `streaming_events` capability (Section 10.3). For an adapter that declares
  `streaming_events=false`, the only events are session start and turn end, so `stall_timeout_ms`
  effectively becomes a wall-clock cap on a whole turn. Implementations MUST document this and
  operators SHOULD size the value for the adapter in use.
>>>>>>> REPLACE
