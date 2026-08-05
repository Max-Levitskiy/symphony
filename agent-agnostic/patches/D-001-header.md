<<<<<<< FIND
# Symphony Service Specification

Status: Draft v1 (language-agnostic)

Purpose: Define a service that orchestrates coding agents to get project work done.
=======
<!-- delta: D-001 -->

# Symphony Service Specification (Agent-Agnostic Fork)

Status: Draft v1 (language-agnostic), agent-agnostic fork

Purpose: Define a service that orchestrates coding agents to get project work done, without binding
the service to a single coding-agent vendor or wire protocol.

Relationship to upstream:

- This document is generated from the upstream Symphony specification by applying `DELTA.md`. It is
  build output. Do not edit it by hand; see `RULES.md`.
- Every difference from upstream carries an inline HTML comment naming the delta entry that
  produced it, for example `<!-- delta: D-011 -->`. Grep a marker in `DELTA.md` to find out why a
  passage reads the way it does.
- Upstream section numbering is preserved exactly. Fork-only material is appended inside an
  existing section or added as a new appendix; nothing is renumbered.

The structural change is a single one. Upstream integrates one coding agent — Codex, over the Codex
app-server protocol — directly into the orchestrator. This fork moves that integration behind an
`Agent Adapter` boundary that mirrors the `Issue Tracker Adapter` boundary upstream already has, and
ships the Codex integration as one adapter among several. A deployment that wants upstream's exact
behavior selects the `codex-app-server` adapter and gets it.
>>>>>>> REPLACE
