<<<<<<< FIND
- Load runtime behavior from a repository-owned `WORKFLOW.md` contract.
=======
- Load runtime behavior from a repository-owned `WORKFLOW.md` contract.
<!-- delta: D-002 -->
- Integrate coding agents through a replaceable adapter, so no vendor protocol, message schema, or
  session model is baked into the orchestrator.
- Let a workflow switch coding agents by editing configuration, without changing orchestrator code
  or the workflow prompt.
>>>>>>> REPLACE
<<<<<<< FIND
- Mandating a single default approval, sandbox, or operator-confirmation posture for all
  implementations.
=======
- Mandating a single default approval, sandbox, or operator-confirmation posture for all
  implementations.
<!-- delta: D-002 -->
- Normalizing coding-agent feature sets. Agent adapters declare what their runtime supports and the
  orchestrator selects a documented fallback; the orchestrator never emulates a missing agent
  feature.
- Defining a portable wire protocol for coding agents. Each adapter speaks its runtime's native
  protocol and maps it onto the normalized vocabulary in Section 10.
>>>>>>> REPLACE
