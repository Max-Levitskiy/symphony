<<<<<<< FIND
- `codex.command` is preserved as a shell command string
=======
<!-- delta: D-017 -->
- `runner.kind` resolves to a registered agent adapter and an unknown kind fails preflight
- `runner.command` is preserved as a shell command string and `runner.provider` keys are preserved
  verbatim, including keys the core does not recognize
- `runner.env` values resolve `$VAR` indirection
- A workflow with only a legacy `codex` block normalizes to `runner.kind = codex-app-server` with
  `approval_policy`, `thread_sandbox`, and `turn_sandbox_policy` carried into `runner.provider`
- A workflow with both `runner` and `codex` uses `runner` alone and warns
>>>>>>> REPLACE
<<<<<<< FIND
- Coding-agent app-server subprocess client with the targeted transport/framing protocol
- Codex launch command config (`codex.command`, default `codex app-server`)
=======
<!-- delta: D-017 -->
- Agent adapter registry with explicit `runner.kind` selection, per-adapter capability declaration,
  and the normalized event/outcome vocabulary of Section 10
- At least one registered agent adapter with a published profile (Section 10.10)
- Agent runtime config (`runner.kind`, `runner.command`, `runner.provider`, `runner.env`) plus the
  deprecated `codex` compatibility shim
- Capability fallbacks implemented for every capability the registered adapters can declare `false`
>>>>>>> REPLACE
<<<<<<< FIND
- Provider-native agent tools, when shipped, execute through the app-server session using
  host-side configured adapter auth without passing tracker secrets to the child.
=======
<!-- delta: D-017 -->
- Provider-native tracker tools, when shipped, execute through the agent session using host-side
  configured adapter auth without passing tracker secrets to the child, on any agent adapter that
  declares `client_tools=true`.
- More than one registered agent adapter, so the Section 10 boundary is exercised rather than
  assumed. An implementation with exactly one adapter is conforming but has not demonstrated
  portability.
>>>>>>> REPLACE
