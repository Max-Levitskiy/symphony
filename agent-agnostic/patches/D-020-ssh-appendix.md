<<<<<<< FIND
- The coding-agent app-server is launched over SSH stdio instead of as a local subprocess, so the
  orchestrator still owns the session lifecycle even though commands execute remotely.
=======
<!-- delta: D-020 -->
- The selected agent adapter's subprocess is launched over SSH stdio instead of locally, so the
  orchestrator still owns the session lifecycle even though commands execute remotely.
- This extension therefore composes only with adapters that launch a local subprocess over stdio.
  An adapter that reaches a runtime some other way (an HTTP endpoint, an in-process library) MUST
  state in its profile whether it supports remote workers, and what `workspace.root` and workspace
  confinement mean when it does. An adapter that does not support the extension MUST fail session
  startup with `agent_capability_unsupported` when a worker is assigned to a remote host, rather
  than silently running the agent on the orchestrator host.
>>>>>>> REPLACE
<<<<<<< FIND
- A remote host SHOULD satisfy the same basic contract as a local worker environment: reachable
  shell, writable workspace root, coding-agent executable, and any required auth or repository
  prerequisites.
=======
<!-- delta: D-020 -->
- A remote host SHOULD satisfy the same basic contract as a local worker environment: reachable
  shell, writable workspace root, whatever runtime the selected agent adapter needs, the values in
  `runner.env`, and any required auth or repository prerequisites.
>>>>>>> REPLACE
<<<<<<< FIND
- Remote environment drift:
  - Each host needs the expected shell environment, coding-agent executable, auth, and repository
    prerequisites.
=======
<!-- delta: D-020 -->
- Remote environment drift:
  - Each host needs the expected shell environment, the agent runtime required by the configured
    `runner.kind`, auth, and repository prerequisites. Changing `runner.kind` changes the
    prerequisites on every host in the pool at once.
>>>>>>> REPLACE
