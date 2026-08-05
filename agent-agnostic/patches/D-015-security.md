<<<<<<< FIND
- Do not place literal tracker credentials in a repo-owned `WORKFLOW.md` when the child can read
  that workspace; use host-side secret references instead.
=======
- Do not place literal tracker credentials in a repo-owned `WORKFLOW.md` when the child can read
  that workspace; use host-side secret references instead.
<!-- delta: D-015 -->
- `runner.env` is the one channel that intentionally passes secrets to the agent child, because a
  coding-agent runtime usually needs its own provider credential. Populate it with `$VAR`
  references, never literals.
- Agent adapters MUST declare `sensitive_environment_names()` so those values are redacted from
  logs, snapshots, and error messages. This is a redaction contract, distinct from the tracker
  adapter's `secret_environment_names()`, which is a removal contract for the child environment.
>>>>>>> REPLACE
<<<<<<< FIND
Running Codex agents against repositories, issue trackers, and other inputs that can contain
sensitive data or externally-controlled content can be dangerous. A permissive deployment can lead
to data leaks, destructive mutations, or full machine compromise if the agent is induced to execute
harmful commands or use overly-powerful integrations.
=======
<!-- delta: D-015 -->
Running coding agents against repositories, issue trackers, and other inputs that can contain
sensitive data or externally-controlled content can be dangerous. A permissive deployment can lead
to data leaks, destructive mutations, or full machine compromise if the agent is induced to execute
harmful commands or use overly-powerful integrations.

Making the agent runtime pluggable widens this surface rather than narrowing it. Different runtimes
offer very different controls, and some offer none: an adapter that declares `approvals=false`
because its runtime has no approval protocol provides no approval control at all, no matter how the
workflow is written. Implementations MUST NOT assume that switching adapters preserves a security
posture, and SHOULD re-evaluate hardening whenever `runner.kind` changes.
>>>>>>> REPLACE
<<<<<<< FIND
- Tightening Codex approval and sandbox settings described elsewhere in this specification instead
  of running with a maximally permissive configuration.
- Adding external isolation layers such as OS/container/VM sandboxing, network restrictions, or
  separate credentials beyond the built-in Codex policy controls.
=======
<!-- delta: D-015 -->
- Tightening whatever approval and sandbox settings the selected agent adapter exposes through
  `runner.provider`, instead of running with a maximally permissive configuration.
- Adding external isolation layers such as OS/container/VM sandboxing, network restrictions, or
  separate credentials. For adapters whose runtime has no built-in policy controls, external
  isolation is the only control, and SHOULD be treated as REQUIRED rather than optional.
>>>>>>> REPLACE
