<<<<<<< FIND
- `Session ID`
  - Compose from coding-agent `thread_id` and `turn_id` as `<thread_id>-<turn_id>`.
=======
<!-- delta: D-005 -->
- `Agent Session Key` and `Agent Turn Key`
  - Adapter-supplied opaque strings identifying the agent-side session and the current turn.
  - An adapter whose runtime exposes native identities MUST use them. An adapter whose runtime has
    no such concept MUST synthesize stable, non-empty values (for example a random session key per
    session and a 1-based counter per turn).
  - Neither value may be used as an orchestrator map key or parsed for meaning. The orchestrator
    keys scheduling state on `issue.id` and treats both values as display/correlation data.
- `Session ID`
  - Compose from the agent session key and turn key as `<session_key>-<turn_key>`.
  - The composition is fixed so log correlation works identically across adapters.
>>>>>>> REPLACE
