<<<<<<< FIND
   - Unsupported tracker kind or invalid adapter-owned tracker configuration
   - Missing coding-agent executable
=======
   - Unsupported tracker kind or invalid adapter-owned tracker configuration
<!-- delta: D-014 -->
   - Unsupported agent kind or invalid adapter-owned `runner` configuration
   - Missing coding-agent runtime (executable, endpoint, or credential, per the adapter)
   - A capability the workflow requires that the selected agent adapter does not declare
>>>>>>> REPLACE
<<<<<<< FIND
3. `Agent Session Failures`
   - Startup handshake failure
   - Turn failed/cancelled
   - Turn timeout
   - User input requested and handled as failure by the implementation's documented policy
   - Subprocess exit
   - Stalled session (no activity)
=======
<!-- delta: D-014 -->
3. `Agent Session Failures`
   - Session startup failure (launch, handshake, or agent-runtime authentication, as defined by the
     selected adapter)
   - Turn failed/cancelled
   - Turn timeout
   - User input requested and handled as failure by the implementation's documented policy
   - Agent process or connection ended mid-turn
   - Stalled session (no activity)
   - Adapter contract violation (a declared capability the adapter did not honor)
>>>>>>> REPLACE
