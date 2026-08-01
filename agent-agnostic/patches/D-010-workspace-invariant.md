<<<<<<< FIND
Invariant 1: Run the coding agent only in the per-issue workspace path.

- Before launching the coding-agent subprocess, validate:
  - `cwd == workspace_path`
=======
<!-- delta: D-010 -->
Invariant 1: Run the coding agent only in the per-issue workspace path.

- Before launching a coding-agent subprocess, validate:
  - `cwd == workspace_path`
- An adapter that does not launch a local subprocess (for example one that drives a remote or
  in-process agent runtime) MUST still confine every agent file operation to `workspace_path`, MUST
  reject a session whose resolved working directory is not exactly `workspace_path`, and MUST
  document in its adapter profile how that confinement is achieved. The orchestrator refuses to
  start a session for an adapter that cannot state this.
>>>>>>> REPLACE
