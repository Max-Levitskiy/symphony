<<<<<<< FIND
6. `Agent Runner`
   - Creates workspace.
   - Builds prompt from issue + workflow template.
   - Launches the coding agent app-server client.
   - Streams agent updates back to the orchestrator.
=======
<!-- delta: D-003 -->
6. `Agent Runner`
   - Creates workspace.
   - Builds prompt from issue + workflow template.
   - Resolves the configured `Agent Adapter` and runs a session inside the workspace.
   - Streams normalized agent updates back to the orchestrator.
   - The `Agent Adapter` is the vendor-specific half of this component. It owns launch, session and
     turn semantics, and the mapping from one coding agent's native protocol onto the normalized
     event and outcome vocabulary of Section 10. It also declares the capabilities the orchestrator
     uses to choose fallback behavior. Selecting a different coding agent means selecting a
     different adapter, and changes nothing else in this list.
>>>>>>> REPLACE
<<<<<<< FIND
4. `Execution Layer` (workspace + agent subprocess)
   - Filesystem lifecycle, workspace preparation, coding-agent protocol.

5. `Integration Layer` (selected tracker adapter)
   - API calls and normalization for tracker data.
   - Provider-native agent tools and centralized tracker authentication.
=======
<!-- delta: D-003 -->
4. `Execution Layer` (workspace + selected agent adapter)
   - Filesystem lifecycle, workspace preparation, agent session and turn lifecycle.
   - One coding agent's native protocol, isolated behind the adapter contract.

5. `Integration Layer` (selected tracker adapter)
   - API calls and normalization for tracker data.
   - Provider-native agent tools and centralized tracker authentication.
>>>>>>> REPLACE
<<<<<<< FIND
- Coding-agent executable that supports the targeted Codex app-server mode.
=======
<!-- delta: D-003 -->
- A coding-agent runtime supported by one of the implementation's registered agent adapters. What
  the runtime must provide (an executable, an endpoint, credentials, a specific CLI mode) is
  adapter-defined and documented in that adapter's profile.
>>>>>>> REPLACE
