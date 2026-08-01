<<<<<<< FIND
- A successful worker exit does not mean the issue is done forever.
- The worker MAY continue through multiple back-to-back coding-agent turns before it exits.
- After each normal turn completion, the worker re-checks the tracker issue state.
- If the issue is still in an active state, the worker SHOULD start another turn on the same live
  coding-agent thread in the same workspace, up to `agent.max_turns`.
- The first turn SHOULD use the full rendered task prompt.
- Continuation turns SHOULD send only continuation guidance to the existing thread, not resend the
  original task prompt that is already present in thread history.
=======
<!-- delta: D-008 -->
- A successful worker exit does not mean the issue is done forever.
- The worker MAY continue through multiple back-to-back coding-agent turns before it exits.
- After each normal turn completion, the worker re-checks the tracker issue state.
- If the issue is still in an active state, the worker SHOULD start another turn in the same
  workspace through the same agent session, up to `agent.max_turns`.
- The first turn SHOULD use the full rendered task prompt.
- What a continuation turn sends depends on the selected adapter's `session_continuation`
  capability (Section 10.3):
  - `session_continuation=true`: send continuation guidance only. The original task prompt is
    already in the agent's own session history, and resending it wastes context and invites the
    agent to restart work it has already done.
  - `session_continuation=false`: send the full rendered task prompt again with the continuation
    guidance appended. The agent retains nothing between turns, so continuation-only guidance would
    be unintelligible.
- The worker MUST decide this from the capability, never from the adapter's name. An adapter that
  gains session continuation later changes behavior by flipping the capability.
>>>>>>> REPLACE
