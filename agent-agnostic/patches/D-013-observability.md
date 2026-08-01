<<<<<<< FIND
- `rate_limits` (latest coding-agent rate limit payload, if available)
=======
- `rate_limits` (latest coding-agent rate limit payload, if available)
<!-- delta: D-013 -->
- `agent_kind` (the `runner.kind` in effect for the snapshot)
- each running row SHOULD include `agent_kind` and `usage_reported`, so an operator can tell an
  agent that reported zero tokens from an agent that cannot report tokens at all
>>>>>>> REPLACE
<<<<<<< FIND
Token accounting rules:

- Agent events can include token counts in multiple payload shapes.
- Prefer absolute thread totals when available, such as:
  - `thread/tokenUsage/updated` payloads
  - `total_token_usage` within token-count wrapper events
- Ignore delta-style payloads such as `last_token_usage` for dashboard/API totals.
- Extract input/output/total token counts leniently from common field names within the selected
  payload.
- For absolute totals, track deltas relative to last reported totals to avoid double-counting.
- Do not treat generic `usage` maps as cumulative totals unless the event type defines them that
  way.
- Accumulate aggregate totals in orchestrator state.
=======
<!-- delta: D-013 -->
Token accounting rules:

- Extracting token counts from a native agent protocol is adapter work, not orchestrator work. The
  selected agent adapter normalizes usage into the `usage` object of Section 10.6 events and MUST
  set `mode` to `cumulative` (absolute session totals) or `incremental` (a delta since the previous
  report).
- The orchestrator accumulates by mode:
  - `cumulative`: add the difference against the last reported totals, so repeated absolute reports
    do not double-count.
  - `incremental`: add directly.
- An adapter MUST NOT label a value `cumulative` unless its runtime defines it that way. When the
  runtime's semantics are ambiguous, the adapter MUST omit the usage report rather than guess; a
  missing number is recoverable, a silently wrong total is not.
- Adapters that declare `usage_reporting=false` never emit usage. Their sessions carry
  `usage_reported=false` and counters stay at `0`.
- Accumulate aggregate totals in orchestrator state.
>>>>>>> REPLACE
<<<<<<< FIND
      "running": {
        "session_id": "thread-1-turn-1",
        "turn_count": 7,
=======
      "running": {
        "agent_kind": "codex-app-server",
        "session_id": "sess-1-turn-1",
        "turn_count": 7,
        "usage_reported": true,
>>>>>>> REPLACE
<<<<<<< FIND
          "issue_id": "abc123",
          "issue_identifier": "MT-649",
          "issue_url": "https://tracker.example/issues/MT-649",
          "state": "In Progress",
          "session_id": "thread-1-turn-1",
          "turn_count": 7,
=======
          "issue_id": "abc123",
          "issue_identifier": "MT-649",
          "issue_url": "https://tracker.example/issues/MT-649",
          "state": "In Progress",
          "agent_kind": "codex-app-server",
          "session_id": "sess-1-turn-1",
          "turn_count": 7,
          "usage_reported": true,
>>>>>>> REPLACE
