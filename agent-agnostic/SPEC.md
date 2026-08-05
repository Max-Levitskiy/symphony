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

## Normative Language

The key words `MUST`, `MUST NOT`, `REQUIRED`, `SHOULD`, `SHOULD NOT`, `RECOMMENDED`, `MAY`, and
`OPTIONAL` in this document are to be interpreted as described in RFC 2119.

`Implementation-defined` means the behavior is part of the implementation contract, but this
specification does not prescribe one universal policy. Implementations MUST document the selected
behavior.

## 1. Problem Statement

Symphony is a long-running automation service that continuously reads work from a configured issue
tracker, creates an isolated workspace for each issue, and runs a coding agent session for that
issue inside the workspace.

The service solves four operational problems:

- It turns issue execution into a repeatable daemon workflow instead of manual scripts.
- It isolates agent execution in per-issue workspaces so agent commands run only inside per-issue
  workspace directories.
- It keeps the workflow policy in-repo (`WORKFLOW.md`) so teams version the agent prompt and runtime
  settings with their code.
- It provides enough observability to operate and debug multiple concurrent agent runs.

Implementations are expected to document their trust and safety posture explicitly. This
specification does not require a single approval, sandbox, or operator-confirmation policy; some
implementations target trusted environments with a high-trust configuration, while others require
stricter approvals or sandboxing.

Important boundary:

- Symphony is a scheduler/runner and tracker reader.
- Ticket writes (state transitions, comments, PR links) are typically performed by the coding agent
  through provider-native tools executed by Symphony with the configured tracker credential.
- When tracker credentials are supplied through host-side secret references, the coding-agent child
  process does not need a duplicate tracker login or direct access to raw tracker credentials.
- A successful run can end at a workflow-defined handoff state (for example `Human Review`), not
  necessarily `Done`.

## 2. Goals and Non-Goals

### 2.1 Goals

- Poll the issue tracker on a fixed cadence and dispatch work with bounded concurrency.
- Maintain a single authoritative orchestrator state for dispatch, retries, and reconciliation.
- Create deterministic per-issue workspaces and preserve them across runs.
- Stop active runs when issue state changes make them ineligible.
- Recover from transient failures with exponential backoff.
- Load runtime behavior from a repository-owned `WORKFLOW.md` contract.
<!-- delta: D-002 -->
- Integrate coding agents through a replaceable adapter, so no vendor protocol, message schema, or
  session model is baked into the orchestrator.
- Let a workflow switch coding agents by editing configuration, without changing orchestrator code
  or the workflow prompt.
- Expose operator-visible observability (at minimum structured logs).
- Support tracker/filesystem-driven restart recovery without requiring a persistent database; exact
  in-memory scheduler state is not restored.

### 2.2 Non-Goals

- Rich web UI or multi-tenant control plane.
- Prescribing a specific dashboard or terminal UI implementation.
- General-purpose workflow engine or distributed job scheduler.
- Built-in business logic for how to edit tickets, PRs, or comments. (That logic lives in the
  workflow prompt and agent tooling.)
- Mandating strong sandbox controls beyond what the coding agent and host OS provide.
- Mandating a single default approval, sandbox, or operator-confirmation posture for all
  implementations.
<!-- delta: D-002 -->
- Normalizing coding-agent feature sets. Agent adapters declare what their runtime supports and the
  orchestrator selects a documented fallback; the orchestrator never emulates a missing agent
  feature.
- Defining a portable wire protocol for coding agents. Each adapter speaks its runtime's native
  protocol and maps it onto the normalized vocabulary in Section 10.

## 3. System Overview

### 3.1 Main Components

1. `Workflow Loader`
   - Reads `WORKFLOW.md`.
   - Parses YAML front matter and prompt body.
   - Returns `{config, prompt_template}`.

2. `Config Layer`
   - Exposes typed getters for workflow config values.
   - Applies defaults and environment variable indirection.
   - Performs validation used by the orchestrator before dispatch.

3. `Issue Tracker Adapter`
   - Fetches candidate issues in active states.
   - Fetches current states for specific issue IDs (reconciliation).
   - Fetches terminal-state issues during startup cleanup.
   - Normalizes tracker payloads into a stable issue model.
   - MAY expose provider-native agent tools without adding provider-specific write APIs to the
     orchestrator.

4. `Orchestrator`
   - Owns the poll tick.
   - Owns the in-memory runtime state.
   - Decides which issues to dispatch, retry, stop, or release.
   - Tracks session metrics and retry queue state.

5. `Workspace Manager`
   - Maps issue identifiers to workspace paths.
   - Ensures per-issue workspace directories exist.
   - Runs workspace lifecycle hooks.
   - Cleans workspaces for terminal issues.

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

7. `Status Surface` (OPTIONAL)
   - Presents human-readable runtime status (for example terminal output, dashboard, or other
     operator-facing view).

8. `Logging`
   - Emits structured runtime logs to one or more configured sinks.

### 3.2 Abstraction Levels

Symphony is easiest to port when kept in these layers:

1. `Policy Layer` (repo-defined)
   - `WORKFLOW.md` prompt body.
   - Team-specific rules for ticket handling, validation, and handoff.

2. `Configuration Layer` (typed getters)
   - Parses front matter into typed runtime settings.
   - Handles defaults, environment tokens, and path normalization.

3. `Coordination Layer` (orchestrator)
   - Polling loop, issue eligibility, concurrency, retries, reconciliation.

<!-- delta: D-003 -->
4. `Execution Layer` (workspace + selected agent adapter)
   - Filesystem lifecycle, workspace preparation, agent session and turn lifecycle.
   - One coding agent's native protocol, isolated behind the adapter contract.

5. `Integration Layer` (selected tracker adapter)
   - API calls and normalization for tracker data.
   - Provider-native agent tools and centralized tracker authentication.

6. `Observability Layer` (logs + OPTIONAL status surface)
   - Operator visibility into orchestrator and agent behavior.

### 3.3 External Dependencies

- One configured issue tracker API.
- Local filesystem for workspaces and logs.
- OPTIONAL workspace population tooling (for example Git CLI, if used).
<!-- delta: D-003 -->
- A coding-agent runtime supported by one of the implementation's registered agent adapters. What
  the runtime must provide (an executable, an endpoint, credentials, a specific CLI mode) is
  adapter-defined and documented in that adapter's profile.
- Host environment authentication for the issue tracker and coding agent. Host-side tracker secret
  environment variables SHOULD NOT be inherited by the coding-agent child process.

## 4. Core Domain Model

### 4.1 Entities

#### 4.1.1 Issue

Normalized schedulable work item used by orchestration, prompt rendering, and observability output.
The name `Issue` is generic in this specification; an adapter MAY map it from a ticket, card,
project item, or another provider-native work object.

Fields:

- `id` (string)
  - REQUIRED stable dispatch identity within the configured tracker scope.
  - Opaque to the orchestrator. It MAY be a project-item or board-entry ID instead of the
    provider's underlying ticket ID.
- `native_ref` (object or null)
  - OPTIONAL non-secret provider identifiers needed by provider-native tools.
  - Opaque to the orchestrator and preserved for prompt/tool context.
- `identifier` (string)
  - REQUIRED human-readable ticket key (example: `ABC-123`).
  - MUST be unique within the configured tracker scope because it names workspaces and
    operator-facing routes. An adapter spanning multiple namespaces MUST disambiguate it.
- `title` (string)
- `description` (string or null)
- `priority` (integer or null)
  - Lower numbers are higher priority in dispatch sorting.
- `state` (string)
  - REQUIRED current provider-native state name.
- `branch_name` (string or null)
  - Tracker-provided branch metadata if available.
- `url` (string or null)
- `assignee_id` (string or null)
- `labels` (list of strings)
  - Normalized to lowercase.
- `blocked_by` (list of blocker refs)
  - Best-effort provider metadata. Each blocker ref contains:
    - `id` (string or null)
    - `identifier` (string or null)
    - `state` (string or null)
- `dispatchable` (boolean)
  - REQUIRED adapter-derived eligibility for provider-specific rules that the generic scheduler
    cannot infer safely, such as assignment, board membership, or blocker semantics.
  - The orchestrator still applies configured state, label, claim, retry, and concurrency rules.
- `created_at` (timestamp or null)
- `updated_at` (timestamp or null)

#### 4.1.2 Workflow Definition

Parsed `WORKFLOW.md` payload:

- `config` (map)
  - YAML front matter root object.
- `prompt_template` (string)
  - Markdown body after front matter, trimmed.

#### 4.1.3 Service Config (Typed View)

Typed runtime values derived from `WorkflowDefinition.config` plus environment resolution.

Examples:

- poll interval
- workspace root
- active and terminal issue states
- concurrency limits
- coding-agent executable/args/timeouts
- workspace hooks

#### 4.1.4 Workspace

Filesystem workspace assigned to one issue identifier.

Fields (logical):

- `path` (absolute workspace path)
- `workspace_key` (collision-resistant sanitized issue identifier)
- `created_now` (boolean, used to gate `after_create` hook)

#### 4.1.5 Run Attempt

One execution attempt for one issue.

Fields (logical):

- `issue_id`
- `issue_identifier`
- `attempt` (integer or null, `null` for first run, `>=1` for retries/continuation)
- `workspace_path`
- `started_at`
- `status`
- `error` (OPTIONAL)

<!-- delta: D-004 -->

#### 4.1.6 Live Session (Agent Session Metadata)

State tracked while a coding-agent session is running.

Fields:

- `agent_kind` (string)
  - The `runner.kind` of the adapter that owns this session. Recorded per session, because a
    workflow reload can change the configured adapter while a session is still running.
- `session_id` (string, `<session_key>-<turn_key>`)
- `session_key` (string)
  - Adapter-supplied identity for the agent-side session, thread, or conversation. Opaque to the
    orchestrator.
- `turn_key` (string)
  - Adapter-supplied identity for the current turn. Opaque to the orchestrator.
- `agent_process_pid` (string or null)
  - Present when the adapter launches a local subprocess; `null` otherwise.
- `last_agent_event` (string/enum or null)
- `last_agent_timestamp` (timestamp or null)
- `last_agent_message` (summarized payload)
- `agent_input_tokens` (integer)
- `agent_output_tokens` (integer)
- `agent_total_tokens` (integer)
- `last_reported_input_tokens` (integer)
- `last_reported_output_tokens` (integer)
- `last_reported_total_tokens` (integer)
- `usage_reported` (boolean)
  - `false` when the selected adapter declares `usage_reporting=false` (Section 10.3). The token
    counters then stay at `0` and consumers MUST present them as "not reported" rather than as
    measured zero usage.
- `turn_count` (integer)
  - Number of agent turns started within the current worker lifetime.

#### 4.1.7 Retry Entry

Scheduled retry state for an issue.

Fields:

- `issue_id`
- `identifier` (best-effort human ID for status surfaces/logs)
- `attempt` (integer, 1-based for retry queue)
- `due_at_ms` (monotonic clock timestamp)
- `timer_handle` (runtime-specific timer reference)
- `error` (string or null)

#### 4.1.8 Orchestrator Runtime State

Single authoritative in-memory state owned by the orchestrator.

Fields:

- `poll_interval_ms` (current effective poll interval)
- `max_concurrent_agents` (current effective global concurrency limit)
- `running` (map `issue_id -> running entry`)
- `claimed` (set of issue IDs reserved/running/retrying)
- `retry_attempts` (map `issue_id -> RetryEntry`)
- `completed` (set of issue IDs; bookkeeping only, not dispatch gating)
- `agent_totals` (aggregate tokens + runtime seconds)
- `agent_rate_limits` (latest rate-limit snapshot from agent events)

### 4.2 Stable Identifiers and Normalization Rules

- `Issue ID`
  - Use for tracker refresh calls and internal map keys.
  - Treat it as an opaque dispatch identity; do not assume it is the provider's underlying ticket
    ID.
- `Native Ref`
  - Preserve as opaque non-secret data for provider-native agent tools and prompt rendering.
  - Never use it as an orchestrator map key or interpret provider-specific fields in core logic.
- `Issue Identifier`
  - Use for human-readable logs and workspace naming.
  - Require uniqueness within the configured tracker scope.
- `Workspace Key`
  - Derive from `issue.identifier` by replacing any character not in `[A-Za-z0-9._-]` with `_`.
  - If sanitization changes the identifier, append a stable hash suffix of the original identifier
    with at least 64 bits of entropy using only allowed workspace-key characters, making keys for
    distinct identifiers that sanitize to the same text collision-resistant.
  - Use the resulting value for the workspace directory name.
- `Normalized Issue State`
  - Compare states after trimming surrounding whitespace and applying `lowercase`.
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

## 5. Workflow Specification (Repository Contract)

### 5.1 File Discovery and Path Resolution

Workflow file path precedence:

1. Explicit application/runtime setting (set by CLI startup path).
2. Default: `WORKFLOW.md` in the current process working directory.

Loader behavior:

- If the file cannot be read, return `missing_workflow_file` error.
- The workflow file is expected to be repository-owned and version-controlled.

### 5.2 File Format

`WORKFLOW.md` is a Markdown file with OPTIONAL YAML front matter.

Design note:

- `WORKFLOW.md` SHOULD be self-contained enough to describe and run different workflows (prompt,
  runtime settings, hooks, and tracker selection/config) without requiring out-of-band
  service-specific configuration.

Parsing rules:

- If file starts with `---`, parse lines until the next `---` as YAML front matter.
- Remaining lines become the prompt body.
- If front matter is absent, treat the entire file as prompt body and use an empty config map.
- YAML front matter MUST decode to a map/object; non-map YAML is an error.
- Prompt body is trimmed before use.

Returned workflow object:

- `config`: front matter root object (not nested under a `config` key).
- `prompt_template`: trimmed Markdown body.

### 5.3 Front Matter Schema

Top-level keys:

<!-- delta: D-006 -->
- `tracker`
- `polling`
- `workspace`
- `hooks`
- `agent`
- `runner`
- `codex` (deprecated compatibility alias for `runner`; see Section 5.3.6)

Unknown keys SHOULD be ignored for forward compatibility.

Note:

- The workflow front matter is extensible. Extensions MAY define additional top-level keys without
  changing the core schema above.
- Extensions SHOULD document their field schema, defaults, validation rules, and whether changes
  apply dynamically or require restart.

#### 5.3.1 `tracker` (object)

Fields:

- `kind` (string)
  - REQUIRED for dispatch.
  - Selects one implementation-supported tracker adapter.
- `provider` (object)
  - Default: `{}`.
  - Adapter-owned configuration such as endpoint, scope/project selector, and credentials.
  - Core Symphony MUST preserve unknown keys and MUST NOT prescribe one cross-provider credential
    or scope schema.
  - Each adapter MUST document its required keys, defaults, secret keys, `$VAR_NAME` support, and
    validation errors.
  - If a documented secret `$VAR_NAME` resolves to an empty string, treat that secret as missing.
- `required_labels` (list of strings)
  - Default: `[]`.
  - An issue MUST contain every configured label to dispatch or continue.
  - Matching ignores case and surrounding whitespace.
  - A blank configured label matches no issue.
- `active_states` (list of strings)
  - REQUIRED unless the selected adapter profile documents a default.
  - Values are provider-native state names compared case-insensitively by the scheduler.
- `terminal_states` (list of strings)
  - REQUIRED unless the selected adapter profile documents a default.
  - Values are provider-native state names compared case-insensitively by the scheduler.

#### 5.3.2 `polling` (object)

Fields:

- `interval_ms` (integer)
  - Default: `30000`
  - Changes SHOULD be re-applied at runtime and affect future tick scheduling without restart.

#### 5.3.3 `workspace` (object)

Fields:

- `root` (path string or `$VAR`)
  - Default: `<system-temp>/symphony_workspaces`
  - `~` is expanded.
  - Relative paths are resolved relative to the directory containing `WORKFLOW.md`.
  - The effective workspace root is normalized to an absolute path before use.

#### 5.3.4 `hooks` (object)

Fields:

- `after_create` (multiline shell script string, OPTIONAL)
  - Runs only when a workspace directory is newly created.
  - Failure aborts workspace creation.
- `before_run` (multiline shell script string, OPTIONAL)
  - Runs before each agent attempt after workspace preparation and before launching the coding
    agent.
  - Failure aborts the current attempt.
- `after_run` (multiline shell script string, OPTIONAL)
  - Runs after each agent attempt (success, failure, timeout, or cancellation) once the workspace
    exists.
  - Failure is logged but ignored.
- `before_remove` (multiline shell script string, OPTIONAL)
  - Runs before workspace deletion if the directory exists.
  - Failure is logged but ignored; cleanup still proceeds.
- `timeout_ms` (integer, OPTIONAL)
  - Default: `60000`
  - Applies to all workspace hooks.
  - Invalid values fail configuration validation.
  - Changes SHOULD be re-applied at runtime for future hook executions.

#### 5.3.5 `agent` (object)

Fields:

- `max_concurrent_agents` (integer)
  - Default: `10`
  - Changes SHOULD be re-applied at runtime and affect subsequent dispatch decisions.
- `max_turns` (positive integer)
  - Default: `20`
  - Limits the number of coding-agent turns within one worker session.
  - Invalid values fail configuration validation.
- `max_retry_backoff_ms` (integer)
  - Default: `300000` (5 minutes)
  - Changes SHOULD be re-applied at runtime and affect future retry scheduling.
- `max_concurrent_agents_by_state` (map `state_name -> positive integer`)
  - Default: empty map.
  - State keys are normalized (`trim + lowercase`) for lookup.
  - Invalid entries (non-positive or non-numeric) are ignored.

<!-- delta: D-006 -->

#### 5.3.6 `runner` (object)

`runner` selects and configures the coding agent. It is the agent-side mirror of `tracker`: a
`kind` that names one adapter, plus an adapter-owned `provider` object the core never interprets.

Core fields:

- `kind` (string)
  - REQUIRED for dispatch.
  - Selects one implementation-supported agent adapter (Section 10.1).
- `command` (string shell command)
  - Default: adapter-defined.
  - The launch command for adapters that start a local subprocess.
  - The runtime launches this command through a local shell in the workspace directory, using the
    same shell contract as workspace hooks (Section 9.4).
  - Adapters that do not launch a subprocess MUST document that they ignore this field.
- `provider` (object)
  - Default: `{}`.
  - Adapter-owned configuration: model selection, approval and sandbox policy, endpoints,
    credentials, protocol options, and anything else specific to one coding agent.
  - Core Symphony MUST preserve unknown keys verbatim and MUST NOT prescribe a cross-agent schema
    for them.
  - Each adapter MUST document its keys, defaults, secret keys, `$VAR_NAME` support, and validation
    errors, exactly as tracker adapters do for `tracker.provider`.
  - If a documented secret `$VAR_NAME` resolves to an empty string, treat that secret as missing.
- `env` (map `string -> string`)
  - Default: `{}`.
  - Extra environment variables for the agent child process, resolved through the same `$VAR_NAME`
    indirection as other config values.
  - This is the supported way to hand agent-runtime credentials to the child. It does not affect
    tracker credentials, which stay host-side (Section 15.3).
- `require_client_tools` (boolean)
  - Default: `false`.
  - When `true`, dispatch preflight fails if the selected adapter declares
    `client_tools=false` (Section 10.3). Use it when the workflow's tracker writes depend on
    host-executed tools and a silent downgrade would be worse than not running.
- `turn_timeout_ms` (integer)
  - Default: `3600000` (1 hour)
  - Maximum silence interval while a turn is active; every adapter-emitted event resets it. It is
    not a total turn runtime cap.
- `read_timeout_ms` (integer)
  - Default: `5000`
  - Request/response timeout for adapter-level synchronous exchanges such as session startup.
- `stall_timeout_ms` (integer)
  - Default: `300000` (5 minutes)
  - Enforced by the orchestrator based on event inactivity.
  - If `<= 0`, stall detection is disabled.

Timeout fields are core because the orchestrator enforces them. Everything that varies per coding
agent lives in `provider`.

Deprecated `codex` compatibility alias:

Upstream Symphony spells this block `codex`. To keep upstream `WORKFLOW.md` files working
unchanged, an implementation MUST accept the legacy block and normalize it before validation:

- If `runner` is absent and `codex` is present, synthesize:
  - `runner.kind = "codex-app-server"`
  - `runner.command = codex.command` (default `codex app-server`)
  - `runner.turn_timeout_ms`, `runner.read_timeout_ms`, `runner.stall_timeout_ms` from the
    same-named `codex` fields
  - `runner.provider` = every remaining `codex` key verbatim, which carries `approval_policy`,
    `thread_sandbox`, and `turn_sandbox_policy` through to the Codex adapter unchanged
- If both `runner` and `codex` are present, `runner` wins entirely; the implementation MUST emit an
  operator-visible deprecation warning and MUST NOT merge the two blocks.
- If neither is present, `runner.kind` is missing and dispatch preflight fails (Section 6.3).

The alias is a translation, not a second code path: after normalization the rest of the service sees
only `runner`.

### 5.4 Prompt Template Contract

The Markdown body of `WORKFLOW.md` is the per-issue prompt template.

Rendering requirements:

- Use a strict template engine (Liquid-compatible semantics are sufficient).
- Unknown variables MUST fail rendering.
- Unknown filters MUST fail rendering.

Template input variables:

- `issue` (object)
  - Includes all normalized issue fields, including labels and blockers.
- `attempt` (integer or null)
  - `null`/absent on first attempt.
  - Integer on retry or continuation run.

Fallback prompt behavior:

- If the workflow prompt body is empty, the runtime MAY use a minimal default prompt
  (`You are working on an issue from the configured tracker.`).
- Workflow file read/parse failures are configuration/validation errors and SHOULD NOT silently fall
  back to a prompt.

### 5.5 Workflow Validation and Error Surface

Error classes:

- `missing_workflow_file`
- `workflow_parse_error`
- `workflow_front_matter_not_a_map`
- `template_parse_error` (during prompt rendering)
- `template_render_error` (unknown variable/filter, invalid interpolation)

Dispatch gating behavior:

- Workflow file read/YAML errors block new dispatches until fixed.
- Template errors fail only the affected run attempt.

## 6. Configuration Specification

### 6.1 Configuration Resolution Pipeline

Configuration is resolved in this order:

1. Select the workflow file path (explicit runtime setting, otherwise cwd default).
2. Parse YAML front matter into a raw config map.
3. Apply built-in defaults for missing OPTIONAL fields.
4. Resolve `$VAR_NAME` indirection for config values that explicitly contain `$VAR_NAME`, plus any
   adapter-owned fallback environment names documented for omitted provider fields.
5. Coerce and validate typed values.

Environment variables do not globally override YAML values. They are used only when a config value
explicitly references them, or when an adapter profile documents a host-side fallback for an
omitted provider field. Such a fallback is adapter-local, not a cross-provider convention.

Value coercion semantics:

- Path/command fields support:
  - `~` home expansion
  - `$VAR` expansion for env-backed path values
  - Apply expansion only to values intended to be local filesystem paths; do not rewrite URIs or
    arbitrary shell command strings.
- Relative `workspace.root` values resolve relative to the directory containing the selected
  `WORKFLOW.md`.

### 6.2 Dynamic Reload Semantics

Dynamic reload is REQUIRED:

- The software MUST detect `WORKFLOW.md` changes.
- On change, it MUST re-read and re-apply workflow config and prompt template without restart.
- The software MUST attempt to adjust live behavior to the new config (for example polling
  cadence, concurrency limits, active/terminal states, agent runtime settings, workspace paths/hooks, and
  prompt content for future runs).
- Reloaded config applies to future dispatch, retry scheduling, reconciliation decisions, hook
  execution, and agent launches.
- Implementations are not REQUIRED to restart in-flight agent sessions automatically when config
  changes.
- Extensions that manage their own listeners/resources (for example an HTTP server port change) MAY
  require restart unless the implementation explicitly supports live rebind.
- Implementations SHOULD also re-validate/reload defensively during runtime operations (for example
  before dispatch) in case filesystem watch events are missed.
- Invalid reloads MUST NOT crash the service; keep operating with the last known good effective
  configuration and emit an operator-visible error.

### 6.3 Dispatch Preflight Validation

This validation is a scheduler preflight run before attempting to dispatch new work. It validates
the workflow/config needed to poll and launch workers, not a full audit of all possible workflow
behavior.

Startup validation:

- Validate configuration before starting the scheduling loop.
- If startup validation fails, fail startup and emit an operator-visible error.

Per-tick dispatch validation:

- Re-validate before each dispatch cycle.
- If validation fails, skip dispatch for that tick, keep reconciliation active, and emit an
  operator-visible error.

Validation checks:

<!-- delta: D-007 -->
- Workflow file can be loaded and parsed.
- `tracker.kind` is present and supported.
- The selected adapter accepts `tracker.provider` after documented defaults and `$VAR`
  resolution.
- `runner.kind` is present (after the legacy `codex` normalization in Section 5.3.6) and resolves
  to a registered agent adapter.
- The selected agent adapter accepts `runner` after documented defaults and `$VAR` resolution. For
  an adapter that launches a subprocess this includes a non-empty effective `runner.command`.
- If `runner.require_client_tools` is `true`, the selected agent adapter declares
  `client_tools=true`.

### 6.4 Core Config Fields Summary (Cheat Sheet)

This section is intentionally redundant so a coding agent can implement the config layer quickly.
Extension fields are documented in the extension section that defines them. Core conformance does
not require recognizing or validating extension fields unless that extension is implemented.

- `tracker.kind`: string, REQUIRED, selects one supported adapter
- `tracker.provider`: object, default `{}`, adapter-owned endpoint/scope/auth settings
- `tracker.required_labels`: list of strings, default `[]`
- `tracker.active_states`: list of provider-native state names, adapter-defined default
- `tracker.terminal_states`: list of provider-native state names, adapter-defined default
- `polling.interval_ms`: integer, default `30000`
- `workspace.root`: path resolved to absolute, default `<system-temp>/symphony_workspaces`
- `hooks.after_create`: shell script or null
- `hooks.before_run`: shell script or null
- `hooks.after_run`: shell script or null
- `hooks.before_remove`: shell script or null
- `hooks.timeout_ms`: integer, default `60000`
- `agent.max_concurrent_agents`: integer, default `10`
- `agent.max_turns`: integer, default `20`
- `agent.max_retry_backoff_ms`: integer, default `300000` (5m)
- `agent.max_concurrent_agents_by_state`: map of positive integers, default `{}`
<!-- delta: D-007 -->
- `runner.kind`: string, REQUIRED, selects one registered agent adapter
- `runner.command`: shell command string, adapter-defined default, ignored by adapters that do not
  launch a subprocess
- `runner.provider`: object, default `{}`, adapter-owned model/policy/endpoint/auth settings
- `runner.env`: map of strings, default `{}`, extra environment for the agent child process
- `runner.require_client_tools`: boolean, default `false`
- `runner.turn_timeout_ms`: integer, default `3600000`
- `runner.read_timeout_ms`: integer, default `5000`
- `runner.stall_timeout_ms`: integer, default `300000`
- `codex.*`: deprecated; normalized into `runner` per Section 5.3.6

## 7. Orchestration State Machine

The orchestrator is the only component that mutates scheduling state. All worker outcomes are
reported back to it and converted into explicit state transitions.

### 7.1 Issue Orchestration States

This is not the same as tracker states (`Todo`, `In Progress`, etc.). This is the service's internal
claim state.

1. `Unclaimed`
   - Issue is not running and has no retry scheduled.

2. `Claimed`
   - Orchestrator has reserved the issue to prevent duplicate dispatch.
   - In practice, claimed issues are either `Running` or `RetryQueued`.

3. `Running`
   - Worker task exists and the issue is tracked in `running` map.

4. `RetryQueued`
   - Worker is not running, but a retry timer exists in `retry_attempts`.

5. `Released`
   - Claim removed because issue is terminal, non-active, missing, or retry path completed without
     re-dispatch.

Important nuance:

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
- Once the worker exits normally, the orchestrator still schedules a short continuation retry
  (about 1 second) so it can re-check whether the issue remains active and needs another worker
  session.

### 7.2 Run Attempt Lifecycle

A run attempt transitions through these phases:

1. `PreparingWorkspace`
2. `BuildingPrompt`
3. `LaunchingAgentProcess`
4. `InitializingSession`
5. `StreamingTurn`
6. `Finishing`
7. `Succeeded`
8. `Failed`
9. `TimedOut`
10. `Stalled`
11. `CanceledByReconciliation`

Distinct terminal reasons are important because retry logic and logs differ.

### 7.3 Transition Triggers

- `Poll Tick`
  - Reconcile active runs.
  - Validate config.
  - Fetch candidate issues.
  - Dispatch until slots are exhausted.

- `Worker Exit (normal)`
  - Remove running entry.
  - Update aggregate runtime totals.
  - Schedule continuation retry (attempt `1`) after the worker exhausts or finishes its in-process
    turn loop.

- `Worker Exit (abnormal)`
  - Remove running entry.
  - Update aggregate runtime totals.
  - Schedule exponential-backoff retry.

- `Agent Update Event`
  - Update live session fields, token counters, and rate limits.

- `Retry Timer Fired`
  - Re-fetch active candidates and attempt re-dispatch, or release claim if no longer eligible.

- `Reconciliation State Refresh`
  - Stop runs whose issue states are terminal or no longer active.

- `Stall Timeout`
  - Kill worker and schedule retry.

### 7.4 Idempotency and Recovery Rules

- The orchestrator serializes state mutations through one authority to avoid duplicate dispatch.
- `claimed` and `running` checks are REQUIRED before launching any worker.
- Reconciliation runs before dispatch on every tick.
- Restart recovery is tracker-driven and filesystem-driven (without a durable orchestrator DB).
- Startup terminal cleanup removes stale workspaces for issues already in terminal states.

## 8. Polling, Scheduling, and Reconciliation

### 8.1 Poll Loop

At startup, the service validates config, performs startup cleanup, schedules an immediate tick, and
then repeats every `polling.interval_ms`.

The effective poll interval SHOULD be updated when workflow config changes are re-applied.

Tick sequence:

1. Reconcile running issues.
2. Run dispatch preflight validation.
3. Fetch candidate issues from tracker using active states.
4. Sort issues by dispatch priority.
5. Dispatch eligible issues while slots remain.
6. Notify observability/status consumers of state changes.

If per-tick validation fails, dispatch is skipped for that tick, but reconciliation still happens
first.

### 8.2 Candidate Selection Rules

An issue is dispatch-eligible only if all are true:

- It has `id`, `identifier`, `title`, and `state`.
- Its state is in `active_states` and not in `terminal_states`.
- Its adapter-provided `dispatchable` value is `true`.
- It contains every label in `tracker.required_labels`.
- It is not already in `running`.
- It is not already in `claimed`.
- Global concurrency slots are available.
- Per-state concurrency slots are available.

For refresh and continuation checks, `issue_routable(issue)` means only that adapter-provided
`dispatchable` is true and all `tracker.required_labels` match. State, claims, and concurrency are
checked separately by the surrounding algorithm.

Sorting order (stable intent):

1. `priority` ascending for values `1..4`; all other integers and null sort after that bucket
2. `created_at` oldest first; null sorts last
3. `identifier` lexicographic tie-breaker

### 8.3 Concurrency Control

Global limit:

- `available_slots = max(max_concurrent_agents - running_count, 0)`

Per-state limit:

- `max_concurrent_agents_by_state[state]` if present (state key normalized)
- otherwise fallback to global limit

The runtime counts issues by their current tracked state in the `running` map.

### 8.4 Retry and Backoff

Retry entry creation:

- Cancel any existing retry timer for the same issue.
- Store `attempt`, `identifier`, `error`, `due_at_ms`, and new timer handle.

Backoff formula:

- Normal continuation retries after a clean worker exit use a short fixed delay of `1000` ms.
- Failure-driven retries use `delay = min(10000 * 2^(attempt - 1), agent.max_retry_backoff_ms)`.
- Power is capped by the configured max retry backoff (default `300000` / 5m).

Retry handling behavior:

1. Refresh the specific issue with `fetch_issues_by_ids([issue_id])`.
2. If not found, release claim.
3. If found in a terminal state, clean its workspace and release claim.
4. If found and still active and routable:
   - Dispatch if slots are available.
   - Otherwise requeue with error `no available orchestrator slots`.
5. If found but no longer active or routable, release claim without dispatch.

Note:

- Terminal-state workspace cleanup is handled by startup cleanup, active-run reconciliation, and
  retry refreshes that observe a terminal transition.
- ID refresh avoids treating a terminal, non-active, or newly unroutable issue as merely absent.

### 8.5 Active Run Reconciliation

Reconciliation runs every tick and has two parts.

Part A: Stall detection

<!-- delta: D-009 -->
- For each running issue, compute `elapsed_ms` since:
  - `last_agent_timestamp` if any event has been seen, else
  - `started_at`
- If `elapsed_ms > runner.stall_timeout_ms`, terminate the worker and queue a retry.
- If `stall_timeout_ms <= 0`, skip stall detection entirely.
- Stall detection measures event silence, so its meaning depends on the selected adapter's
  `streaming_events` capability (Section 10.3). For an adapter that declares
  `streaming_events=false`, the only events are session start and turn end, so `stall_timeout_ms`
  effectively becomes a wall-clock cap on a whole turn. Implementations MUST document this and
  operators SHOULD size the value for the adapter in use.

Part B: Tracker state refresh

- Fetch current issue states for all running issue IDs.
- For each running issue:
  - If tracker state is terminal: terminate worker and clean workspace.
  - If tracker state is still active and routable: update the in-memory issue snapshot.
  - If tracker state is active but no longer routable: terminate worker without workspace cleanup.
  - If tracker state is neither active nor terminal: terminate worker without workspace cleanup.
- If state refresh fails, keep workers running and try again on the next tick.

### 8.6 Startup Terminal Workspace Cleanup

When the service starts:

1. Query tracker for issues in terminal states.
2. For each returned issue identifier, remove the corresponding workspace directory.
3. If the terminal-issues fetch fails, log a warning and continue startup.

This prevents stale terminal workspaces from accumulating after restarts.

## 9. Workspace Management and Safety

### 9.1 Workspace Layout

Workspace root:

- `workspace.root` (normalized absolute path)

Per-issue workspace path:

- `<workspace.root>/<workspace_key>`

Workspace persistence:

- Workspaces are reused across runs for the same issue.
- Successful runs do not auto-delete workspaces.

### 9.2 Workspace Creation and Reuse

Input: `issue.identifier`

Algorithm summary:

1. Derive `workspace_key` using Section 4.2, including the stable original-identifier hash when
   sanitization changes the identifier.
2. Compute workspace path under workspace root.
3. Ensure the workspace path exists as a directory.
4. Mark `created_now=true` only if the directory was created during this call; otherwise
   `created_now=false`.
5. If `created_now=true`, run `after_create` hook if configured.

Notes:

- This section does not assume any specific repository/VCS workflow.
- Workspace preparation beyond directory creation (for example dependency bootstrap, checkout/sync,
  code generation) is implementation-defined and is typically handled via hooks.

### 9.3 OPTIONAL Workspace Population (Implementation-Defined)

The spec does not require any built-in VCS or repository bootstrap behavior.

Implementations MAY populate or synchronize the workspace using implementation-defined logic and/or
hooks (for example `after_create` and/or `before_run`).

Failure handling:

- Workspace population/synchronization failures return an error for the current attempt.
- If failure happens while creating a brand-new workspace, implementations MAY remove the partially
  prepared directory.
- Reused workspaces SHOULD NOT be destructively reset on population failure unless that policy is
  explicitly chosen and documented.

### 9.4 Workspace Hooks

Supported hooks:

- `hooks.after_create`
- `hooks.before_run`
- `hooks.after_run`
- `hooks.before_remove`

Execution contract:

- Execute in a local shell context appropriate to the host OS, with the workspace directory as
  `cwd`.
- On POSIX systems, `sh -lc <script>` (or a stricter equivalent such as `bash -lc <script>`) is a
  conforming default.
- Hook timeout uses `hooks.timeout_ms`; default: `60000 ms`.
- Log hook start, failures, and timeouts.

Failure semantics:

- `after_create` failure or timeout is fatal to workspace creation.
- `before_run` failure or timeout is fatal to the current run attempt.
- `after_run` failure or timeout is logged and ignored.
- `before_remove` failure or timeout is logged and ignored.

### 9.5 Safety Invariants

This is the most important portability constraint.

<!-- delta: D-010 -->
Invariant 1: Run the coding agent only in the per-issue workspace path.

- Before launching a coding-agent subprocess, validate:
  - `cwd == workspace_path`
- An adapter that does not launch a local subprocess (for example one that drives a remote or
  in-process agent runtime) MUST still confine every agent file operation to `workspace_path`, MUST
  reject a session whose resolved working directory is not exactly `workspace_path`, and MUST
  document in its adapter profile how that confinement is achieved. The orchestrator refuses to
  start a session for an adapter that cannot state this.

Invariant 2: Workspace path MUST stay inside workspace root.

- Normalize both paths to absolute.
- Require `workspace_path` to have `workspace_root` as a prefix directory.
- Reject any path outside the workspace root.

Invariant 3: Workspace key is sanitized.

- Only `[A-Za-z0-9._-]` allowed in workspace directory names.
- Replace all other characters with `_`.
- If replacement changes the identifier, append a stable original-identifier hash suffix with at
  least 64 bits of entropy so keys remain collision-resistant after sanitization.

<!-- delta: D-011 -->

## 10. Agent Runtime Integration Contract

This section replaces upstream's Codex app-server protocol section. It defines a portable boundary
between the orchestrator and *one* coding agent, in the same shape Section 11 defines for issue
trackers: a small required read/execute kernel, an explicit capability declaration, and a normalized
vocabulary the orchestrator understands.

The boundary exists to make one statement true:

> The orchestrator MUST NOT contain code that is specific to any coding agent. Everything
> agent-specific — transport, framing, method names, message schemas, approval semantics, sandbox
> configuration, usage payload shapes — lives inside one agent adapter.

Protocol source of truth:

- An adapter's native protocol is defined by the coding agent it targets, not by this document.
  This specification never describes a wire format.
- An adapter MUST send messages that are valid for the runtime version it targets, and MUST document
  which versions it targets.
- Where this specification and a targeted runtime protocol appear to conflict, the runtime protocol
  controls protocol shape and transport; this section controls orchestration behavior, workspace
  selection, prompt construction, continuation handling, capability fallback, and observability
  extraction.

### 10.1 Adapter Selection and Registry

- An implementation maintains an `agent adapter registry` mapping `runner.kind` values to adapters.
- `runner.kind` selects exactly one adapter for a dispatch. An unknown value is a dispatch preflight
  failure (`unsupported_agent_kind`), not a runtime failure.
- Adapter selection, the effective `runner` config, and the resulting capability set MUST be bound
  to one session snapshot at session start. A workflow reload applies to future sessions; it MUST
  NOT change the adapter, capabilities, or policy of a session already running.
- An implementation MUST register at least one adapter to be useful, and SHOULD register more than
  one so the boundary is exercised rather than assumed.
- Adapters MUST NOT be selected implicitly by probing the host for installed executables. Selection
  is configuration, so a deployment is reproducible.

### 10.2 REQUIRED Adapter Operations

An implementation MUST support these adapter operations. Signatures are language-neutral; an
implementation MAY express them as an interface, a module contract, a record of closures, or any
equivalent construct.

```text
capabilities() -> Capabilities
validate_config(runner_config) -> ok | error{category, message}
sensitive_environment_names() -> list<string>
start_session(params) -> ok(Session) | error{category, message}
run_turn(session, turn_input, on_event) -> ok(TurnOutcome) | error{category, message}
stop_session(session) -> ok | error{category, message}
```

`start_session` parameters:

- `workspace_path` (absolute per-issue workspace path; the session's working directory)
- `issue` (normalized issue from Section 4.1.1, for titles and adapter-side context)
- `runner_config` (effective `runner` object after defaults and `$VAR` resolution)
- `tools` (list of client-side tool specs to advertise; empty when unsupported or unused)
- `execute_tool(name, arguments) -> ToolResult` (host-side callback; see Section 10.7)
- `on_event(event)` (normalized event sink; see Section 10.6)
- `environment` (resolved child environment, already stripped of tracker secrets)

`Session` MUST expose at least:

- `session_key` (Section 4.2)
- `agent_process_pid` (string or null)
- `capabilities` (the snapshot bound at start; see Section 10.1)

`turn_input`:

- `turn_number` (1-based within the current worker lifetime)
- `kind` (`initial` or `continuation`)
- `text` (the rendered prompt for this turn, already resolved per Section 7.1 continuation rules)
- `title` (OPTIONAL display title, for example `<issue.identifier>: <issue.title>`)

`TurnOutcome`:

- `status` (one of `completed`, `failed`, `cancelled`, `timed_out`, `input_required`)
- `turn_key` (Section 4.2)
- `error_category` (string or null; RECOMMENDED categories in Section 10.8)
- `message` (string or null, human-readable, secret-free)

Only `completed` is a success. The worker treats every other status as a failed attempt and lets the
orchestrator apply the retry rules in Section 8.4.

### 10.3 Capability Declaration and REQUIRED Fallbacks

Coding agents differ. The orchestrator adapts to those differences through a declared capability
set, never by inspecting `runner.kind`. Every capability is a boolean and MUST be declared
explicitly; there is no default.

```text
Capabilities = {
  session_continuation:  boolean,
  streaming_events:      boolean,
  client_tools:          boolean,
  approvals:             boolean,
  cancellation:          boolean,
  usage_reporting:       boolean,
  rate_limit_reporting:  boolean
}
```

Each capability has a REQUIRED fallback when it is `false`. The fallback is normative: an
implementation MUST behave as described rather than failing or improvising.

- `session_continuation` — the runtime keeps conversation state across turns in one session.
  - `false`: the worker MUST send the full rendered task prompt on every turn (Section 7.1), and
    the adapter MAY internally start a fresh runtime invocation per turn. Multi-turn work still
    functions because the workspace, not the agent's memory, carries state between turns.
- `streaming_events` — the runtime emits progress events while a turn is in flight.
  - `false`: the adapter MUST still emit `session_started` and exactly one terminal turn event per
    turn. Stall detection then measures whole-turn elapsed time (Section 8.5).
- `client_tools` — the runtime can call host-provided tools during a turn.
  - `false`: the runtime MUST NOT advertise tools, MUST emit one `client_tools_unavailable` event
    per session, and MUST continue. Tracker writes then depend on whatever the workflow policy layer
    arranges out of band. Dispatch fails instead only when `runner.require_client_tools` is `true`
    (Section 6.3).
- `approvals` — the runtime asks the client to approve commands or file changes.
  - `false`: the adapter MUST launch the runtime in a mode that never blocks on approval, and MUST
    document that mode in its profile. The orchestrator MUST NOT synthesize approvals.
- `cancellation` — the runtime supports cooperative cancellation of an in-flight turn.
  - `false`: `stop_session` and reconciliation-driven termination MUST terminate the underlying
    process or connection. Termination is still REQUIRED to be prompt; losing partial work is
    acceptable, hanging is not.
- `usage_reporting` — the runtime reports token usage.
  - `false`: token counters remain `0`, `usage_reported` is `false` on the live session, and
    observability consumers MUST render "not reported" rather than zero (Section 13.5).
- `rate_limit_reporting` — the runtime reports provider rate-limit state.
  - `false`: the rate-limit snapshot stays `null`.

Capability rules:

- Capabilities are static per adapter, or derived from `runner.provider` at `start_session` time.
  They MUST NOT change during a session.
- An adapter MUST NOT declare a capability it cannot honor. Declaring `client_tools=true` and then
  ignoring advertised tools is a conformance failure, not a degraded mode.
- Adding a capability to this list is a specification change. Adapters MUST reject an unknown
  capability key rather than silently ignoring it, so a newer orchestrator never assumes support
  from an older adapter.

### 10.4 Session Startup Responsibilities

Startup follows the targeted runtime's own contract. Symphony additionally requires the adapter to:

- Start the session with the absolute per-issue workspace path as the working directory, and refuse
  to start if that path is not the workspace path (Section 9.5).
- Apply `runner.env` on top of the inherited environment for any child process it launches.
- Apply the implementation's documented approval and sandbox posture using whatever mechanism the
  targeted runtime provides, or declare `approvals=false` and run in a non-blocking mode.
- Advertise the supplied client-side tool specs when `client_tools=true`.
- Produce a non-empty `session_key`.
- Emit `session_started` once, or `startup_failed` with a category from Section 10.8.
- Include issue-identifying metadata such as `<issue.identifier>: <issue.title>` wherever the
  targeted runtime accepts a session or turn title.

Startup MUST NOT require the orchestrator to know anything about the runtime's handshake. If a
runtime needs a multi-step handshake, capability negotiation, or authentication exchange, that is
entirely inside `start_session`.

### 10.5 Turn Execution and Completion

The adapter runs one turn per `run_turn` call and returns exactly one `TurnOutcome`.

Completion mapping:

- runtime turn completion -> `completed`
- runtime turn failure -> `failed`
- runtime turn cancellation -> `cancelled`
- no adapter event for `runner.turn_timeout_ms` while a turn is active -> `timed_out`
- underlying process or connection ends mid-turn -> `failed` with category `agent_exit`
- runtime requests user input and the implementation's documented policy does not satisfy it ->
  `input_required`

Continuation processing:

- When `session_continuation=true`, the same session MUST stay alive across continuation turns and
  be stopped only when the worker run ends.
- When `session_continuation=false`, the adapter MAY tear down and re-create runtime state between
  turns. The orchestrator does not observe the difference: `session_key` MUST remain stable for the
  whole worker run either way, so logs and snapshots stay correlated.

Transport handling:

- Follow the transport and framing rules of the targeted runtime.
- For stdio-based transports, keep the protocol stream separate from diagnostic stderr unless the
  targeted protocol specifies otherwise, and bound line buffering (10 MB is a RECOMMENDED maximum
  line size).

### 10.6 Normalized Runtime Events

The adapter emits normalized events to the orchestrator callback. This vocabulary is the entire
observability contract; the orchestrator never parses a native payload.

Each event SHOULD include:

- `event` (enum/string from the list below)
- `timestamp` (UTC timestamp)
- `agent_kind` (the selected `runner.kind`)
- `agent_process_pid` (if available)
- OPTIONAL `usage` object: `{input_tokens, output_tokens, total_tokens, mode}` where `mode` is
  `cumulative` or `incremental` (Section 13.5)
- OPTIONAL `rate_limits` object (adapter-owned shape, treated as opaque display data)
- OPTIONAL `message` (short, human-readable, secret-free summary)
- OPTIONAL `native` (raw payload retained for debugging; implementations SHOULD truncate it and
  MUST NOT let orchestrator logic depend on it)

Normalized event names:

- `session_started`
- `startup_failed`
- `turn_started`
- `turn_completed`
- `turn_failed`
- `turn_cancelled`
- `turn_timed_out`
- `turn_input_required`
- `approval_requested`
- `approval_resolved`
- `tool_call_completed`
- `tool_call_failed`
- `unsupported_tool_call`
- `client_tools_unavailable`
- `usage_updated`
- `rate_limits_updated`
- `notification`
- `other_message`
- `malformed`

An adapter MUST map every native signal it cares about onto exactly one of these names, and MUST use
`notification` or `other_message` for native signals with no normalized equivalent rather than
inventing a name. Orchestrator logic MUST depend only on this list.

### 10.7 Approval, Tool Calls, and User Input Policy

Approval, sandbox, and user-input behavior is implementation-defined, subject to these requirements.

Policy requirements:

- Each implementation MUST document its chosen approval, sandbox, and operator-confirmation posture,
  per adapter, because the available controls differ per runtime.
- Approval requests and user-input-required signals MUST NOT leave a run stalled indefinitely. An
  implementation MAY satisfy them, surface them to an operator, auto-resolve them, or fail the run
  according to its documented policy.
- An adapter that declares `approvals=false` MUST run its runtime in a mode where these signals
  cannot arrive.

Example high-trust behavior:

- Auto-approve command execution approvals for the session.
- Auto-approve file-change approvals for the session.
- Treat user-input-required turns as hard failure.

Client-side tools:

- Client-side tools are the mechanism by which the coding agent performs tracker writes with
  host-held credentials (Section 11.5). They are available only when `client_tools=true`.
- The tools advertised in a session are exactly the selected tracker adapter's
  `agent_tool_specs()`. Tool names, schemas, and result payloads stay adapter-owned; Symphony does
  not standardize a lowest-common-denominator CRUD API.
- The runtime MUST execute advertised tool calls host-side with the active tracker adapter
  configuration and MUST NOT require the coding-agent child process to read raw tracker tokens from
  disk or environment.
- The runtime SHOULD pass the current normalized issue to the tracker adapter as internal execution
  context, so `issue.id` and `issue.native_ref` preserve provider richness without teaching the
  orchestrator provider semantics.
- Tool specs, tracker adapter selection, agent adapter selection, and effective settings MUST be
  bound to one session snapshot (Section 10.1).
- If the agent requests a tool that is not advertised or not supported, the adapter MUST return a
  structured failure result through the targeted protocol, emit `unsupported_tool_call`, and
  continue the session. A session MUST NOT stall on an unsupported tool path.

Minimal language-neutral tracker-adapter hooks for this extension (unchanged from upstream):

```text
agent_tool_specs() -> list<ToolSpec>
secret_environment_names() -> list<string>
execute_agent_tool(name, arguments, context={issue}) -> ToolResult
```

`ToolResult` MUST distinguish success from failure and carry JSON-safe structured output that the
agent adapter can translate into the targeted runtime's tool-result shape. The context contains the
normalized issue, never the credential.

Tracker credentials SHOULD NOT be inherited by the coding-agent child process. A tracker adapter
that resolves credentials from environment variables MUST declare which secret environment names the
launcher removes from local and remote child environments. Literal credentials in a repo-owned
`WORKFLOW.md` remain readable to a child with workspace access and SHOULD NOT be used when this
isolation matters.

User-input-required policy:

- Implementations MUST document how `turn_input_required` outcomes are handled.
- A run MUST NOT stall indefinitely waiting for user input.
- A conforming implementation MAY fail the run, surface the request to an operator, satisfy it
  through an approved operator channel, or auto-resolve it according to its documented policy.

### 10.8 Timeouts and Error Mapping

Timeouts:

- `runner.read_timeout_ms`: request/response timeout during session startup and synchronous adapter
  exchanges
- `runner.turn_timeout_ms`: maximum silence interval while a turn is active; each adapter event
  resets it, so it is not a total turn runtime cap
- `runner.stall_timeout_ms`: enforced by the orchestrator based on event inactivity (Section 8.5)

Error mapping (RECOMMENDED normalized categories):

- `unsupported_agent_kind`
- `invalid_runner_config`
- `missing_agent_secret`
- `agent_runtime_not_found`
- `agent_capability_unsupported`
- `invalid_workspace_cwd`
- `response_timeout`
- `turn_timeout`
- `agent_exit`
- `response_error`
- `turn_failed`
- `turn_cancelled`
- `turn_input_required`

As with tracker adapters (Section 11.4), a literal `{category, message}` object is not required; an
implementation MAY use a language-native tagged error, exception, tuple, or enum as long as its
adapter profile documents the mapping to a stable category and a human-readable message. The
orchestrator relies only on success versus failure and on the category for logging and retry
labeling.

### 10.9 Agent Runner Contract

The `Agent Runner` wraps workspace + prompt + selected agent adapter.

Behavior:

1. Create or reuse the workspace for the issue.
2. Resolve the agent adapter from `runner.kind`; an unresolvable kind fails the attempt with
   `unsupported_agent_kind`.
3. Build the prompt from the workflow template.
4. Start the agent session with the workspace as working directory.
5. Forward normalized adapter events to the orchestrator.
6. Run turns per Section 7.1, choosing continuation prompt content from the
   `session_continuation` capability.
7. Stop the session on exit, then run the `after_run` hook.
8. On any error, fail the worker attempt; the orchestrator decides retry behavior.

Note:

- Workspaces are intentionally preserved after successful runs.
- The runner is the only component allowed to hold an adapter handle. Orchestrator state stores
  normalized session metadata (Section 4.1.6), never an adapter-specific object.

### 10.10 Adapter Profile Publication

Each agent adapter MUST publish a compact profile in implementation documentation, not only in code,
containing:

- the exact supported `runner.kind` value;
- the targeted coding-agent runtime and version range, and how to check the installed version;
- the exact `runner.provider` keys, defaults, secret keys and environment names, and validation
  errors;
- the default `runner.command`, or an explicit statement that the adapter launches no subprocess
  and how it confines file operations to the workspace (Section 9.5);
- the declared capability set and the reason for every `false`;
- the mapping from native protocol signals to the normalized event names in Section 10.6;
- the mapping from native errors to the categories in Section 10.8;
- the approval and sandbox posture the adapter configures, and what it does not control;
- whether usage reports are `cumulative` or `incremental`.

This mirrors the tracker adapter profile requirement in Section 11.2. A capability set without a
published profile is not verifiable, and an unverifiable adapter is not conforming.

## 11. Issue Tracker Integration Contract

The issue tracker boundary is deliberately small: a portable read kernel for scheduling plus
OPTIONAL provider-native agent tools. Do not add generic comment/state/attachment CRUD merely to
make providers look alike; those operations lose useful provider semantics and are not needed by
the orchestrator.

### 11.1 REQUIRED Adapter Operations

An implementation MUST support these adapter operations:

1. `fetch_issues_by_states(state_names)`
   - Return normalized issues visible in the configured tracker scope and requested state names.
   - The adapter MUST apply provider-side scope selection and pagination.
   - Used with configured active states for candidate polling and terminal states for startup
     cleanup.
   - When used for candidate polling, include active scoped issues even when
     `dispatchable=false`; the scheduler owns that final filter.
   - The orchestrator applies `required_labels`, `dispatchable`, claims, retries, and concurrency
     after normalization.
   - An empty `state_names` list MUST return an empty result without a provider request.

2. `fetch_issues_by_ids(issue_ids)`
   - Return current normalized issue snapshots for the supplied opaque dispatch IDs.
   - Used for active-run reconciliation and stale-dispatch revalidation.
   - An empty `issue_ids` list MUST return an empty result without a provider request.
   - IDs no longer visible in the configured scope are omitted; the orchestrator treats omission as
     "no longer visible" rather than inventing a synthetic state.

Both operations return either `ok(list<Issue>)` or an adapter error. For portability, an adapter
error SHOULD expose a stable category and human-readable message. An implementation MAY use a
language-native tagged error, exception, tuple, or enum instead of a literal error object when its
adapter profile documents how those public error forms map to category and message. The
orchestrator relies only on success versus failure.

The operations are atomic from the scheduler's perspective after a paging or transport failure. For
these rules, a record is malformed only when the adapter cannot produce the required normalized
fields (`id`, `identifier`, `title`, `state`, and explicit `dispatchable`) or cannot produce a
valid `Issue` after applying the optional-field fallback rules in Section 11.3. Unusable nullable
or best-effort provider metadata MAY normalize to `null`, an empty list, or omitted best-effort
entries; that fallback alone does not make a record malformed.

A state-list call MAY omit an individually malformed provider record because it was never safe to
dispatch, and SHOULD log that omission. An ID-refresh call MUST fail instead of silently omitting a
malformed requested record, because omission is meaningful. A successful
`fetch_issues_by_ids` result is complete for that call. Output order is not significant, input IDs
are treated as a set, and each dispatch ID appears at most once.

The refresh operation returns full normalized snapshots, not only state strings, because label,
assignment, routing, and provider-specific dispatchability can change while a run is active.

### 11.2 Adapter Responsibilities

Each adapter owns:

- construction from the current effective tracker configuration, including active/terminal states;
- endpoint, authentication, transport, timeouts, pagination, and rate-limit handling;
- provider-specific scope selection (project, board, team, repository, query, or equivalent);
- mapping provider payloads into the normalized Issue fields in Section 4.1.1;
- choosing a stable dispatch identity and preserving any distinct underlying IDs in `native_ref`;
- deriving `dispatchable` from provider-specific routing rules;
- preserving provider-native state names while allowing case-insensitive scheduler comparison;
- OPTIONAL provider-native agent tools and their authorization boundary.

The orchestrator MUST NOT inspect provider payloads, assume that `issue.id` is an underlying
ticket ID, or branch on provider-specific blocker, board, transition, or comment semantics.

Each adapter MUST publish a compact profile in implementation documentation, not only code,
containing:

- exact supported `tracker.kind` value;
- exact `tracker.provider` keys, defaults, secret keys/environment names, and validation errors;
- scope selection, pagination behavior, and provider request limits;
- `id` and `native_ref` mapping;
- state, label, priority, timestamp, `dispatchable`, malformed-record, and optional-field
  normalization;
- provider-native tool names/schemas, mutation capability, scope, and result/error behavior if any;
- mapping from public language-native error forms to portable transport/auth/rate-limit error
  categories and human-readable messages.

### 11.3 Normalization Rules

Adapter output MUST satisfy Section 4.1.1. In addition:

- Every listed field MUST be present in the normalized record. Nullable fields use `null`;
  collection fields use an empty list when absent.
- `id`, `identifier`, `title`, and `state` MUST be non-empty strings.
- `labels` MUST be trimmed, lowercased strings; blank labels MUST be dropped and duplicate labels
  SHOULD be removed.
- `priority` MUST be an integer or null.
- The scheduler ranks priorities `1..4` before null/unknown values; other integers sort with
  null/unknown unless an implementation documents a different mapping.
- `created_at` and `updated_at` MUST represent parsed RFC 3339 instants or null; the in-memory
  timestamp type is implementation-defined.
- Unusable provider values for nullable fields MAY normalize to `null`. Unusable best-effort
  collection entries MAY be dropped; if no usable entries remain, use an empty list. These
  fallbacks MUST NOT be used for `id`, `identifier`, `title`, `state`, or explicit
  `dispatchable`.
- Preserve provider spelling in `state`, but trim and lowercase only for scheduler comparisons.
- `blocked_by` is best-effort metadata; adapters MUST NOT invent blocker semantics they cannot
  represent reliably.
- `dispatchable` MUST be explicit. It is `true` only when provider-specific eligibility checks
  pass; the generic scheduler never tries to reconstruct those checks from `native_ref`.
- `native_ref` MUST be null or a JSON-safe object containing only non-secret values safe to expose
  in prompt/tool context. If provider metadata cannot be represented safely, normalize
  `native_ref` to null; otherwise preserve the retained object verbatim.

### 11.4 Error Handling Contract

RECOMMENDED adapter error categories:

- `unsupported_tracker_kind`
- `invalid_tracker_config`
- `missing_tracker_secret`
- `tracker_request` (transport failure)
- `tracker_status` (non-success response)
- `tracker_response` (malformed or semantically invalid payload)
- `tracker_pagination` (pagination integrity failure)
- `tracker_rate_limited`

For portability, every adapter profile MUST document how each public language-native error form
maps to a stable `category` and human-readable `message`. A literal `{category, message}`
object is not required. Adapters MAY add `retryable`, `retry_after_ms`, provider status, and
provider-specific detail, but the orchestrator only relies on success vs. failure.

Orchestrator behavior on tracker errors:

- Candidate fetch failure: log and skip dispatch for this tick.
- Running-state refresh failure: log and keep active workers running.
- Startup terminal cleanup failure: log warning and continue startup.

### 11.5 Tracker Writes and Agent Tools (Important Boundary)

Symphony does not require first-class tracker write APIs in the orchestrator.

<!-- delta: D-012 -->
- Ticket mutations (state transitions, comments, attachments, PR metadata) are typically handled by
  the coding agent through the selected tracker adapter's provider-native tools.
- Tools execute in Symphony with the configured adapter credential; the child receives tool results,
  not a raw token.
- This path requires the selected agent adapter to declare `client_tools=true` (Section 10.3). When
  it does not, the tools are simply not advertised and the workflow policy layer owns tracker writes
  by other means. Set `runner.require_client_tools: true` to make that downgrade a dispatch
  preflight failure instead of a silent one.
- The current normalized issue is available to tool execution as context, including opaque
  `native_ref`, so adapters can retain provider richness without adding it to the core scheduler.
- The service remains a scheduler/runner and tracker reader.
- Workflow-specific success often means "reached the next handoff state" (for example
  `Human Review`) rather than tracker terminal state `Done`.

## 12. Prompt Construction and Context Assembly

### 12.1 Inputs

Inputs to prompt rendering:

- `workflow.prompt_template`
- normalized `issue` object
- OPTIONAL `attempt` integer (retry/continuation metadata)

### 12.2 Rendering Rules

- Render with strict variable checking.
- Render with strict filter checking.
- Convert issue object keys to strings for template compatibility.
- Preserve nested arrays/maps (labels, blockers) so templates can iterate.

### 12.3 Retry/Continuation Semantics

`attempt` SHOULD be passed to the template as a 1-based retry/continuation count:

- first run: `attempt` is null or absent;
- any later run: `attempt` is an integer.

The core `attempt` value does not distinguish a normal continuation from an error/timeout/stall
retry. An implementation MAY expose an additional `retry_kind` template field if workflows need
that distinction, but it is not part of core conformance.

### 12.4 Failure Semantics

If prompt rendering fails:

- Fail the run attempt immediately.
- Let the orchestrator treat it like any other worker failure and decide retry behavior.

## 13. Logging, Status, and Observability

### 13.1 Logging Conventions

REQUIRED context fields for issue-related logs:

- `issue_id`
- `issue_identifier`

REQUIRED context for coding-agent session lifecycle logs:

- `session_id`

Message formatting requirements:

- Use stable `key=value` phrasing.
- Include action outcome (`completed`, `failed`, `retrying`, etc.).
- Include concise failure reason when present.
- Avoid logging large raw payloads unless necessary.

### 13.2 Logging Outputs and Sinks

The spec does not prescribe where logs are written (stderr, file, remote sink, etc.).

Requirements:

- Operators MUST be able to see startup/validation/dispatch failures without attaching a debugger.
- Implementations MAY write to one or more sinks.
- If a configured log sink fails, the service SHOULD continue running when possible and emit an
  operator-visible warning through any remaining sink.

### 13.3 Runtime Snapshot / Monitoring Interface (OPTIONAL but RECOMMENDED)

If the implementation exposes a synchronous runtime snapshot (for dashboards or monitoring), it
SHOULD return:

- `running` (list of running session rows)
- each running row SHOULD include `turn_count`
- `retrying` (list of retry queue rows)
- session and retry rows SHOULD include the tracker-provided issue URL when available
- `agent_totals`
  - `input_tokens`
  - `output_tokens`
  - `total_tokens`
  - `seconds_running` (aggregate runtime seconds as of snapshot time, including active sessions)
- `rate_limits` (latest coding-agent rate limit payload, if available)
<!-- delta: D-013 -->
- `agent_kind` (the `runner.kind` in effect for the snapshot)
- each running row SHOULD include `agent_kind` and `usage_reported`, so an operator can tell an
  agent that reported zero tokens from an agent that cannot report tokens at all

RECOMMENDED snapshot error modes:

- `timeout`
- `unavailable`

### 13.4 OPTIONAL Human-Readable Status Surface

A human-readable status surface (terminal output, dashboard, etc.) is OPTIONAL and
implementation-defined.

If present, it SHOULD draw from orchestrator state/metrics only and MUST NOT be REQUIRED for
correctness.

### 13.5 Session Metrics and Token Accounting

<!-- delta: D-013 -->
Token accounting rules:

- Extracting token counts from a native agent protocol is adapter work, not orchestrator work. The
  selected agent adapter normalizes usage into the `usage` object of Section 10.6 events and MUST
  set `mode` to `cumulative` (absolute session totals) or `incremental` (a delta since the previous
  report).
- The orchestrator accumulates by mode:
  - `cumulative`: add the difference against the last reported totals, so repeated absolute reports
    do not double-count.
  - `incremental`: add directly.
- An adapter MUST NOT label a value `cumulative` unless its runtime defines it that way. When the
  runtime's semantics are ambiguous, the adapter MUST omit the usage report rather than guess; a
  missing number is recoverable, a silently wrong total is not.
- Adapters that declare `usage_reporting=false` never emit usage. Their sessions carry
  `usage_reported=false` and counters stay at `0`.
- Accumulate aggregate totals in orchestrator state.

Runtime accounting:

- Runtime SHOULD be reported as a live aggregate at snapshot/render time.
- Implementations MAY maintain a cumulative counter for ended sessions and add active-session
  elapsed time derived from `running` entries (for example `started_at`) when producing a
  snapshot/status view.
- Add run duration seconds to the cumulative ended-session runtime when a session ends (normal exit
  or cancellation/termination).
- Continuous background ticking of runtime totals is not REQUIRED.

Rate-limit tracking:

- Track the latest rate-limit payload seen in any agent update.
- Any human-readable presentation of rate-limit data is implementation-defined.

### 13.6 Humanized Agent Event Summaries (OPTIONAL)

Humanized summaries of raw agent protocol events are OPTIONAL.

If implemented:

- Treat them as observability-only output.
- Do not make orchestrator logic depend on humanized strings.

### 13.7 OPTIONAL HTTP Server Extension

This section defines an OPTIONAL HTTP interface for observability and operational control.

If implemented:

- The HTTP server is an extension and is not REQUIRED for conformance.
- The implementation MAY serve server-rendered HTML or a client-side application for the dashboard.
- The dashboard/API MUST be observability/control surfaces only and MUST NOT become REQUIRED for
  orchestrator correctness.

Extension config:

- `server.port` (integer, OPTIONAL)
  - Enables the HTTP server extension.
  - `0` requests an ephemeral port for local development and tests.
  - CLI `--port` overrides `server.port` when both are present.

Enablement (extension):

- Start the HTTP server when a CLI `--port` argument is provided.
- Start the HTTP server when `server.port` is present in `WORKFLOW.md` front matter.
- The `server` top-level key is owned by this extension.
- Positive `server.port` values bind that port.
- Implementations SHOULD bind loopback by default (`127.0.0.1` or host equivalent) unless explicitly
  configured otherwise.
- Changes to HTTP listener settings (for example `server.port`) do not need to hot-rebind;
  restart-required behavior is conformant.

#### 13.7.1 Human-Readable Dashboard (`/`)

- Host a human-readable dashboard at `/`.
- The returned document SHOULD depict the current state of the system (for example active sessions,
  retry delays, token consumption, runtime totals, recent events, and health/error indicators).
- It is up to the implementation whether this is server-generated HTML or a client-side app that
  consumes the JSON API below.

#### 13.7.2 JSON REST API (`/api/v1/*`)

Provide a JSON REST API under `/api/v1/*` for current runtime state and operational debugging.

Minimum endpoints:

- `GET /api/v1/state`
  - Returns a summary view of the current system state (running sessions, retry queue/delays,
    aggregate token/runtime totals, latest rate limits, and any additional tracked summary fields).
  - Suggested response shape:

    ```json
    {
      "generated_at": "2026-02-24T20:15:30Z",
      "counts": {
        "running": 2,
        "retrying": 1
      },
      "running": [
        {
          "issue_id": "abc123",
          "issue_identifier": "MT-649",
          "issue_url": "https://tracker.example/issues/MT-649",
          "state": "In Progress",
          "agent_kind": "codex-app-server",
          "session_id": "sess-1-turn-1",
          "turn_count": 7,
          "usage_reported": true,
          "last_event": "turn_completed",
          "last_message": "",
          "started_at": "2026-02-24T20:10:12Z",
          "last_event_at": "2026-02-24T20:14:59Z",
          "tokens": {
            "input_tokens": 1200,
            "output_tokens": 800,
            "total_tokens": 2000
          }
        }
      ],
      "retrying": [
        {
          "issue_id": "def456",
          "issue_identifier": "MT-650",
          "issue_url": "https://tracker.example/issues/MT-650",
          "attempt": 3,
          "due_at": "2026-02-24T20:16:00Z",
          "error": "no available orchestrator slots"
        }
      ],
      "agent_totals": {
        "input_tokens": 5000,
        "output_tokens": 2400,
        "total_tokens": 7400,
        "seconds_running": 1834.2
      },
      "rate_limits": null
    }
    ```

- `GET /api/v1/<issue_identifier>`
  - Returns issue-specific runtime/debug details for the identified issue, including any information
    the implementation tracks that is useful for debugging.
  - Suggested response shape:

    ```json
    {
      "issue_identifier": "MT-649",
      "issue_id": "abc123",
      "status": "running",
      "workspace": {
        "path": "/tmp/symphony_workspaces/MT-649"
      },
      "attempts": {
        "restart_count": 1,
        "current_retry_attempt": 2
      },
      "running": {
        "agent_kind": "codex-app-server",
        "session_id": "sess-1-turn-1",
        "turn_count": 7,
        "usage_reported": true,
        "state": "In Progress",
        "started_at": "2026-02-24T20:10:12Z",
        "last_event": "notification",
        "last_message": "Working on tests",
        "last_event_at": "2026-02-24T20:14:59Z",
        "tokens": {
          "input_tokens": 1200,
          "output_tokens": 800,
          "total_tokens": 2000
        }
      },
      "retry": null,
      "logs": {
        "agent_session_logs": [
          {
            "label": "latest",
            "path": "/var/log/symphony/agent/MT-649/latest.log",
            "url": null
          }
        ]
      },
      "recent_events": [
        {
          "at": "2026-02-24T20:14:59Z",
          "event": "notification",
          "message": "Working on tests"
        }
      ],
      "last_error": null,
      "tracked": {}
    }
    ```

  - If the issue is unknown to the current in-memory state, return `404` with an error response (for
    example `{\"error\":{\"code\":\"issue_not_found\",\"message\":\"...\"}}`).

- `POST /api/v1/refresh`
  - Queues an immediate tracker poll + reconciliation cycle (best-effort trigger; implementations
    MAY coalesce repeated requests).
  - Suggested request body: empty body or `{}`.
  - Suggested response (`202 Accepted`) shape:

    ```json
    {
      "queued": true,
      "coalesced": false,
      "requested_at": "2026-02-24T20:15:30Z",
      "operations": ["poll", "reconcile"]
    }
    ```

API design notes:

- The JSON shapes above are the RECOMMENDED baseline for interoperability and debugging ergonomics.
- Implementations MAY add fields, but SHOULD avoid breaking existing fields within a version.
- Endpoints SHOULD be read-only except for operational triggers like `/refresh`.
- Unsupported methods on defined routes SHOULD return `405 Method Not Allowed`.
- API errors SHOULD use a JSON envelope such as `{"error":{"code":"...","message":"..."}}`.
- If the dashboard is a client-side app, it SHOULD consume this API rather than duplicating state
  logic.

## 14. Failure Model and Recovery Strategy

### 14.1 Failure Classes

1. `Workflow/Config Failures`
   - Missing `WORKFLOW.md`
   - Invalid YAML front matter
   - Unsupported tracker kind or invalid adapter-owned tracker configuration
<!-- delta: D-014 -->
   - Unsupported agent kind or invalid adapter-owned `runner` configuration
   - Missing coding-agent runtime (executable, endpoint, or credential, per the adapter)
   - A capability the workflow requires that the selected agent adapter does not declare

2. `Workspace Failures`
   - Workspace directory creation failure
   - Workspace population/synchronization failure (implementation-defined; can come from hooks)
   - Invalid workspace path configuration
   - Hook timeout/failure

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

4. `Tracker Failures`
   - Provider transport errors
   - Non-success provider responses
   - Provider-reported application errors
   - Malformed payloads

5. `Observability Failures`
   - Snapshot timeout
   - Dashboard render errors
   - Log sink configuration failure

### 14.2 Recovery Behavior

- Dispatch validation failures:
  - Skip new dispatches.
  - Keep service alive.
  - Continue reconciliation where possible.

- Worker failures:
  - Convert to retries with exponential backoff.

- Tracker candidate-fetch failures:
  - Skip this tick.
  - Try again on next tick.

- Reconciliation state-refresh failures:
  - Keep current workers.
  - Retry on next tick.

- Dashboard/log failures:
  - Do not crash the orchestrator.

### 14.3 Partial State Recovery (Restart)

Current design is intentionally in-memory for scheduler state.
Restart recovery means the service can resume useful operation by polling tracker state and reusing
preserved workspaces. It does not mean retry timers, running sessions, or live worker state survive
process restart.

After restart:

- No retry timers are restored from prior process memory.
- No running sessions are assumed recoverable.
- Service recovers by:
  - startup terminal workspace cleanup
  - fresh polling of active issues
  - re-dispatching eligible work

### 14.4 Operator Intervention Points

Operators can control behavior by:

- Editing `WORKFLOW.md` (prompt and most runtime settings).
- `WORKFLOW.md` changes are detected and re-applied automatically without restart according to
  Section 6.2.
- Changing issue states in the tracker:
  - terminal state -> running session is stopped and workspace cleaned when reconciled
  - non-active state -> running session is stopped without cleanup
- Restarting the service for process recovery or deployment (not as the normal path for applying
  workflow config changes).

## 15. Security and Operational Safety

### 15.1 Trust Boundary Assumption

Each implementation defines its own trust boundary.

Operational safety requirements:

- Implementations SHOULD state clearly whether they are intended for trusted environments, more
  restrictive environments, or both.
- Implementations SHOULD state clearly whether they rely on auto-approved actions, operator
  approvals, stricter sandboxing, or some combination of those controls.
- Workspace isolation and path validation are important baseline controls, but they are not a
  substitute for whatever approval and sandbox policy an implementation chooses.

### 15.2 Filesystem Safety Requirements

Mandatory:

- Workspace path MUST remain under configured workspace root.
- Coding-agent cwd MUST be the per-issue workspace path for the current run.
- Workspace directory names MUST use sanitized identifiers.

RECOMMENDED additional hardening for ports:

- Run under a dedicated OS user.
- Restrict workspace root permissions.
- Mount workspace root on a dedicated volume if possible.

### 15.3 Secret Handling

- Support `$VAR` indirection in workflow config.
- Do not log API tokens or secret env values.
- Validate presence of secrets without printing them.
- Execute provider-native tracker tools in the Symphony host process with the configured adapter
  credential.
- Do not pass tracker credentials through the coding-agent child environment. Adapters MUST declare
  secret environment names so local and remote launchers can remove them from child environments.
- Do not place literal tracker credentials in a repo-owned `WORKFLOW.md` when the child can read
  that workspace; use host-side secret references instead.
<!-- delta: D-015 -->
- `runner.env` is the one channel that intentionally passes secrets to the agent child, because a
  coding-agent runtime usually needs its own provider credential. Populate it with `$VAR`
  references, never literals.
- Agent adapters MUST declare `sensitive_environment_names()` so those values are redacted from
  logs, snapshots, and error messages. This is a redaction contract, distinct from the tracker
  adapter's `secret_environment_names()`, which is a removal contract for the child environment.

### 15.4 Hook Script Safety

Workspace hooks are arbitrary shell scripts from `WORKFLOW.md`.

Implications:

- Hooks are fully trusted configuration.
- Hooks run inside the workspace directory.
- Hook output SHOULD be truncated in logs.
- Hook timeouts are REQUIRED to avoid hanging the orchestrator.

### 15.5 Harness Hardening Guidance

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

Implementations SHOULD explicitly evaluate their own risk profile and harden the execution harness
where appropriate. This specification intentionally does not mandate a single hardening posture, but
implementations SHOULD NOT assume that tracker data, repository contents, prompt inputs, or tool
arguments are fully trustworthy just because they originate inside a normal workflow.

Possible hardening measures include:

<!-- delta: D-015 -->
- Tightening whatever approval and sandbox settings the selected agent adapter exposes through
  `runner.provider`, instead of running with a maximally permissive configuration.
- Adding external isolation layers such as OS/container/VM sandboxing, network restrictions, or
  separate credentials. For adapters whose runtime has no built-in policy controls, external
  isolation is the only control, and SHOULD be treated as REQUIRED rather than optional.
- Filtering which issues, projects, boards, teams, labels, or other tracker sources are eligible
  for dispatch so untrusted or out-of-scope tasks do not automatically reach the agent.
- Narrowing provider-native tools so they can only read or mutate data inside the intended tracker
  scope, rather than exposing general workspace-wide tracker access.
- Reducing the set of client-side tools, credentials, filesystem paths, and network destinations
  available to the agent to the minimum needed for the workflow.

The correct controls are deployment-specific, but implementations SHOULD document them clearly and
treat harness hardening as part of the core safety model rather than an optional afterthought.

## 16. Reference Algorithms (Language-Agnostic)

### 16.1 Service Startup

```text
function start_service():
  configure_logging()
  start_observability_outputs()
  start_workflow_watch(on_change=reload_and_reapply_workflow)

  state = {
    poll_interval_ms: get_config_poll_interval_ms(),
    max_concurrent_agents: get_config_max_concurrent_agents(),
    running: {},
    claimed: set(),
    retry_attempts: {},
    completed: set(),
    agent_totals: {input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0},
    agent_rate_limits: null
  }

  validation = validate_dispatch_config()
  if validation is not ok:
    log_validation_error(validation)
    fail_startup(validation)

  startup_terminal_workspace_cleanup()
  schedule_tick(delay_ms=0)

  event_loop(state)
```

### 16.2 Poll-and-Dispatch Tick

```text
on_tick(state):
  state = reconcile_running_issues(state)

  validation = validate_dispatch_config()
  if validation is not ok:
    log_validation_error(validation)
    notify_observers()
    schedule_tick(state.poll_interval_ms)
    return state

  issues = tracker.fetch_issues_by_states(active_states)
  if issues failed:
    log_tracker_error()
    notify_observers()
    schedule_tick(state.poll_interval_ms)
    return state

  for issue in sort_for_dispatch(issues):
    if no_available_slots(state):
      break

    if should_dispatch(issue, state):
      state = dispatch_issue(issue, state, attempt=null)

  notify_observers()
  schedule_tick(state.poll_interval_ms)
  return state
```

### 16.3 Reconcile Active Runs

```text
function reconcile_running_issues(state):
  state = reconcile_stalled_runs(state)

  running_ids = keys(state.running)
  if running_ids is empty:
    return state

  refreshed = tracker.fetch_issues_by_ids(running_ids)
  if refreshed failed:
    log_debug("keep workers running")
    return state

  for issue in refreshed:
    if issue.state in terminal_states:
      state = terminate_running_issue(state, issue.id, cleanup_workspace=true)
    else if issue.state in active_states and issue_routable(issue):
      state.running[issue.id].issue = issue
    else:
      state = terminate_running_issue(state, issue.id, cleanup_workspace=false)

  returned_ids = set(issue.id for issue in refreshed)
  for missing_id in running_ids - returned_ids:
    state = terminate_running_issue(state, missing_id, cleanup_workspace=false)

  return state
```

### 16.4 Dispatch One Issue

```text
function dispatch_issue(issue, state, attempt):
  worker = spawn_worker(
    fn -> run_agent_attempt(issue, attempt, parent_orchestrator_pid) end
  )

  if worker spawn failed:
    return schedule_retry(state, issue.id, next_attempt(attempt), {
      identifier: issue.identifier,
      error: "failed to spawn agent"
    })

  state.running[issue.id] = {
    worker_handle,
    monitor_handle,
    identifier: issue.identifier,
    issue,
    session_id: null,
    agent_process_pid: null,
    last_agent_message: null,
    last_agent_event: null,
    last_agent_timestamp: null,
    agent_input_tokens: 0,
    agent_output_tokens: 0,
    agent_total_tokens: 0,
    last_reported_input_tokens: 0,
    last_reported_output_tokens: 0,
    last_reported_total_tokens: 0,
    retry_attempt: normalize_attempt(attempt),
    started_at: now_utc()
  }

  state.claimed.add(issue.id)
  state.retry_attempts.remove(issue.id)
  return state
```

### 16.5 Worker Attempt (Workspace + Prompt + Agent)

```text
function run_agent_attempt(issue, attempt, orchestrator_channel):
  workspace = workspace_manager.create_for_issue(issue.identifier)
  if workspace failed:
    fail_worker("workspace error")

  if run_hook("before_run", workspace.path) failed:
    fail_worker("before_run hook error")

<!-- delta: D-016 -->
  adapter = agent_registry.resolve(config.runner.kind)
  if adapter is null:
    run_hook_best_effort("after_run", workspace.path)
    fail_worker("unsupported_agent_kind")

  capabilities = adapter.capabilities()

  session = adapter.start_session(
    workspace_path=workspace.path,
    issue=issue,
    runner_config=config.runner,
    tools=(capabilities.client_tools ? tracker.agent_tool_specs() : []),
    execute_tool=(name, args) -> tracker.execute_agent_tool(name, args, {issue: issue}),
    environment=child_environment_without_tracker_secrets()
  )
  if session failed:
    run_hook_best_effort("after_run", workspace.path)
    fail_worker("agent session startup error")

  max_turns = config.agent.max_turns
  turn_number = 1

  while true:
    # A turn resends the full task prompt on turn 1, and on every turn when the adapter
    # cannot carry conversation state between turns (Section 7.1).
    send_full_prompt = (turn_number == 1) or (not capabilities.session_continuation)
    prompt = build_turn_prompt(
      workflow_template, issue, attempt, turn_number, max_turns,
      full_prompt=send_full_prompt
    )
    if prompt failed:
      adapter.stop_session(session)
      run_hook_best_effort("after_run", workspace.path)
      fail_worker("prompt error")

    turn_result = adapter.run_turn(
      session=session,
      turn_input={
        turn_number: turn_number,
        kind: (turn_number == 1 ? initial : continuation),
        text: prompt,
        title: format("%issue.identifier: %issue.title")
      },
      on_event=(event) -> send(orchestrator_channel, {agent_update, issue.id, event})
    )

    if turn_result.status is not completed:
      adapter.stop_session(session)
      run_hook_best_effort("after_run", workspace.path)
      fail_worker(format("agent turn %turn_result.status"))

    refreshed_issue = tracker.fetch_issues_by_ids([issue.id])
    if refreshed_issue failed:
      adapter.stop_session(session)
      run_hook_best_effort("after_run", workspace.path)
      fail_worker("issue state refresh error")

    if refreshed_issue is empty:
      break

    issue = refreshed_issue[0]

    if issue.state is not active or not issue_routable(issue):
      break

    if turn_number >= max_turns:
      break

    turn_number = turn_number + 1

  adapter.stop_session(session)
  run_hook_best_effort("after_run", workspace.path)

  exit_normal()
```

### 16.6 Worker Exit and Retry Handling

```text
on_worker_exit(issue_id, reason, state):
  running_entry = state.running.remove(issue_id)
  state = add_runtime_seconds_to_totals(state, running_entry)

  if reason == normal:
    state.completed.add(issue_id)  # bookkeeping only
    state = schedule_retry(state, issue_id, 1, {
      identifier: running_entry.identifier,
      delay_type: continuation
    })
  else:
    state = schedule_retry(state, issue_id, next_attempt_from(running_entry), {
      identifier: running_entry.identifier,
      error: format("worker exited: %reason")
    })

  notify_observers()
  return state
```

```text
on_retry_timer(issue_id, state):
  retry_entry = state.retry_attempts.pop(issue_id)
  if missing:
    return state

  refreshed = tracker.fetch_issues_by_ids([issue_id])
  if fetch failed:
    return schedule_retry(state, issue_id, retry_entry.attempt + 1, {
      identifier: retry_entry.identifier,
      error: "retry refresh failed"
    })

  issue = find_by_id(refreshed, issue_id)
  if issue is null:
    state.claimed.remove(issue_id)
    return state

  if not retry_dispatch_allowed(issue, state, ignore_existing_claim=issue_id):
    state.claimed.remove(issue_id)
    return state

  if no_available_slots(state):
    return schedule_retry(state, issue_id, retry_entry.attempt + 1, {
      identifier: issue.identifier,
      error: "no available orchestrator slots"
    })

  return dispatch_issue(issue, state, attempt=retry_entry.attempt)
```

## 17. Test and Validation Matrix

A conforming implementation SHOULD include tests that cover the behaviors defined in this
specification.

Validation profiles:

- `Core Conformance`: deterministic tests REQUIRED for all conforming implementations.
- `Extension Conformance`: REQUIRED only for OPTIONAL features that an implementation chooses to
  ship.
- `Real Integration Profile`: environment-dependent smoke/integration checks RECOMMENDED before
  production use.

Unless otherwise noted, Sections 17.1 through 17.7 are `Core Conformance`. Bullets that begin with
`If ... is implemented` are `Extension Conformance`.

### 17.1 Workflow and Config Parsing

- Workflow file path precedence:
  - explicit runtime path is used when provided
  - cwd default is `WORKFLOW.md` when no explicit runtime path is provided
- Workflow file changes are detected and trigger re-read/re-apply without restart
- Invalid workflow reload keeps last known good effective configuration and emits an
  operator-visible error
- Missing `WORKFLOW.md` returns typed error
- Invalid YAML front matter returns typed error
- Front matter non-map returns typed error
- Config defaults apply when OPTIONAL values are missing
- `tracker.kind` validation enforces an implementation-supported adapter
- `tracker.provider` preserves adapter-owned keys and validates them through the selected adapter
- `$VAR` resolution works for documented adapter secret keys and path values
- `~` path expansion works
<!-- delta: D-017 -->
- `runner.kind` resolves to a registered agent adapter and an unknown kind fails preflight
- `runner.command` is preserved as a shell command string and `runner.provider` keys are preserved
  verbatim, including keys the core does not recognize
- `runner.env` values resolve `$VAR` indirection
- A workflow with only a legacy `codex` block normalizes to `runner.kind = codex-app-server` with
  `approval_policy`, `thread_sandbox`, and `turn_sandbox_policy` carried into `runner.provider`
- A workflow with both `runner` and `codex` uses `runner` alone and warns
- Per-state concurrency override map normalizes state names and ignores invalid values
- Prompt template renders `issue` and `attempt`
- Prompt rendering fails on unknown variables (strict mode)

### 17.2 Workspace Manager and Safety

- Deterministic workspace path per issue identifier
- Missing workspace directory is created
- Existing workspace directory is reused
- Existing non-directory path at workspace location is handled safely (replace or fail per
  implementation policy)
- OPTIONAL workspace population/synchronization errors are surfaced
- `after_create` hook runs only on new workspace creation
- `before_run` hook runs before each attempt and failure/timeouts abort the current attempt
- `after_run` hook runs after each attempt and failure/timeouts are logged and ignored
- `before_remove` hook runs on cleanup and failures/timeouts are ignored
- Workspace path sanitization, stable original-identifier-hash collision resistance, and root
  containment invariants are enforced before agent launch
- Identifiers unchanged by sanitization keep their deterministic workspace key; conformance tests
  include distinct identifiers that sanitize to the same text and verify distinct keys
- Agent launch uses the per-issue workspace path as cwd and rejects out-of-root paths

### 17.3 Issue Tracker Adapter

- Candidate issue fetch applies configured active states and adapter-owned scope selection
- Empty `fetch_issues_by_states([])` returns empty without a provider call
- Empty `fetch_issues_by_ids([])` returns empty without a provider call
- Pagination preserves order across multiple pages
- Labels are normalized to lowercase
- Unusable optional provider metadata normalizes to null/empty without hiding valid required fields
- State-list reads log omitted malformed required records; ID refresh fails malformed requested
  records instead of treating them as invisible
- Refresh by opaque dispatch ID returns full normalized issue snapshots
- A distinct provider ticket ID or project-item ID is preserved in `native_ref` when needed
- Provider-specific routing/blocker/assignment rules become explicit `dispatchable`
- The adapter publishes the required compact profile for config, scope, normalization, tools, and
  portable error mapping
- Error mapping covers config, request, non-success response, malformed payload, pagination, and
  rate limiting, including documented category/message mappings for language-native errors

### 17.4 Orchestrator Dispatch, Reconciliation, and Retry

- Dispatch sort order is priority then oldest creation time
- `dispatchable=false` issues are not eligible
- Required-label filtering is case-insensitive and applies after adapter normalization
- Active-state issue refresh updates running entry state
- Non-active state stops running agent without workspace cleanup
- Terminal state stops running agent and cleans workspace
- Reconciliation with no running issues is a no-op
- Normal worker exit schedules a short continuation retry (attempt 1)
- Abnormal worker exit increments retries with 10s-based exponential backoff
- Retry backoff cap uses configured `agent.max_retry_backoff_ms`
- Retry queue entries include attempt, due time, identifier, and error
- Stall detection kills stalled sessions and schedules retry
- Slot exhaustion requeues retries with explicit error reason
- If a snapshot API is implemented, it returns running rows, retry rows, token totals, and rate
  limits
- If a snapshot API is implemented, timeout/unavailable cases are surfaced

<!-- delta: D-017 -->

### 17.5 Agent Adapter and Agent Runner

Registry and configuration:

- `runner.kind` selects the matching adapter; an unregistered kind fails dispatch preflight with
  `unsupported_agent_kind` and never reaches a worker
- Adapter selection, effective `runner` config, and the capability snapshot are bound at session
  start and are unaffected by a workflow reload during the session
- `runner.require_client_tools: true` fails preflight against an adapter declaring
  `client_tools=false`

Adapter contract (run against every registered adapter, and against a test double):

- `validate_config` rejects malformed `runner.provider` values with a documented category
- `start_session` uses the per-issue workspace path as the working directory and rejects any other
  path
- `start_session` applies `runner.env` to the child environment and does not leak tracker secrets
  into it
- `start_session` emits exactly one `session_started`, or `startup_failed` with a category
- `session_key` is non-empty and stable for the whole worker run, including for adapters that
  re-create runtime state between turns
- `run_turn` returns exactly one `TurnOutcome` per call and maps runtime completion, failure,
  cancellation, silence timeout, and process exit onto the correct status
- Every emitted event name is drawn from the Section 10.6 vocabulary
- `stop_session` terminates the runtime promptly for adapters declaring `cancellation=false`
- `sensitive_environment_names` values are redacted from logs, snapshots, and error messages

Capability fallbacks (the portability tests that matter most):

- `session_continuation=false`: continuation turns resend the full rendered prompt; multi-turn runs
  still progress; `session_key` stays stable across the re-created runtime state
- `session_continuation=true`: continuation turns send guidance only and never resend the task
  prompt
- `streaming_events=false`: stall detection still terminates a hung turn using
  `runner.stall_timeout_ms`
- `client_tools=false`: no tools are advertised, one `client_tools_unavailable` event is emitted,
  and the session runs to completion
- `usage_reporting=false`: counters stay `0`, `usage_reported` is `false`, and no fabricated totals
  reach the snapshot
- `rate_limit_reporting=false`: the rate-limit snapshot stays `null`

Orchestration integration:

- Request/response read timeout (`runner.read_timeout_ms`) is enforced during startup
- Turn silence timeout (`runner.turn_timeout_ms`) is enforced and produces `timed_out`
- Approvals and user-input requests are handled per the implementation's documented policy and never
  stall indefinitely
- Unsupported dynamic tool calls are rejected without stalling the session
- Usage reports accumulate correctly for both `cumulative` and `incremental` modes across repeated
  reports
- Two adapters with different capability sets produce the same orchestration outcomes for the same
  issue lifecycle, differing only in prompt content and reported telemetry

If provider-native tracker tools are implemented:

- only the selected tracker adapter's tools are advertised to the session
- valid inputs execute host-side with configured adapter auth
- the current normalized issue and `native_ref` are available as internal tool context
- tracker secrets are not inherited by the coding-agent child process
- invalid arguments, missing auth, and transport failures return structured failure payloads
- unsupported tool names still fail without stalling the session

### 17.6 Observability

- Validation failures are operator-visible
- Structured logging includes issue/session context fields
- Logging sink failures do not crash orchestration
- Token/rate-limit aggregation remains correct across repeated agent updates
- If a human-readable status surface is implemented, it is driven from orchestrator state and does
  not affect correctness
- If humanized event summaries are implemented, they cover key wrapper/agent event classes without
  changing orchestrator behavior

### 17.7 CLI and Host Lifecycle

- CLI accepts a positional workflow path argument (`path-to-WORKFLOW.md`)
- CLI uses `./WORKFLOW.md` when no workflow path argument is provided
- CLI errors on nonexistent explicit workflow path or missing default `./WORKFLOW.md`
- CLI surfaces startup failure cleanly
- CLI exits with success when application starts and shuts down normally
- CLI exits nonzero when startup fails or the host process exits abnormally

### 17.8 Real Integration Profile (RECOMMENDED)

These checks are RECOMMENDED for production readiness and MAY be skipped in CI when credentials,
network access, or external service permissions are unavailable.

- A real tracker smoke test can be run with valid credentials supplied through the selected
  adapter's documented secret mechanism.
- Real integration tests SHOULD use isolated test identifiers/workspaces and clean up tracker
  artifacts when practical.
- A skipped real-integration test SHOULD be reported as skipped, not silently treated as passed.
- If a real-integration profile is explicitly enabled in CI or release validation, failures SHOULD
  fail that job.

## 18. Implementation Checklist (Definition of Done)

Use the same validation profiles as Section 17:

- Section 18.1 = `Core Conformance`
- Section 18.2 = `Extension Conformance`
- Section 18.3 = `Real Integration Profile`

### 18.1 REQUIRED for Conformance

- Workflow path selection supports explicit runtime path and cwd default
- `WORKFLOW.md` loader with YAML front matter + prompt body split
- Typed config layer with defaults and `$` resolution
- Dynamic `WORKFLOW.md` watch/reload/re-apply for config and prompt
- Polling orchestrator with single-authority mutable state
- Issue tracker adapter with state-list + ID-refresh reads
- Workspace manager with sanitized, collision-resistant per-issue workspaces
- Workspace lifecycle hooks (`after_create`, `before_run`, `after_run`, `before_remove`)
- Hook timeout config (`hooks.timeout_ms`, default `60000`)
<!-- delta: D-017 -->
- Agent adapter registry with explicit `runner.kind` selection, per-adapter capability declaration,
  and the normalized event/outcome vocabulary of Section 10
- At least one registered agent adapter with a published profile (Section 10.10)
- Agent runtime config (`runner.kind`, `runner.command`, `runner.provider`, `runner.env`) plus the
  deprecated `codex` compatibility shim
- Capability fallbacks implemented for every capability the registered adapters can declare `false`
- Strict prompt rendering with `issue` and `attempt` variables
- Exponential retry queue with continuation retries after normal exit
- Configurable retry backoff cap (`agent.max_retry_backoff_ms`, default 5m)
- Reconciliation that stops runs on terminal/non-active tracker states
- Workspace cleanup for terminal issues (startup sweep + active transition)
- Structured logs with `issue_id`, `issue_identifier`, and `session_id`
- Operator-visible observability (structured logs; OPTIONAL snapshot/status surface)

### 18.2 RECOMMENDED Extensions (Not REQUIRED for Conformance)

- HTTP server extension honors CLI `--port` over `server.port`, uses a safe default bind host, and
  exposes the baseline endpoints/error semantics in Section 13.7 if shipped.
<!-- delta: D-017 -->
- Provider-native tracker tools, when shipped, execute through the agent session using host-side
  configured adapter auth without passing tracker secrets to the child, on any agent adapter that
  declares `client_tools=true`.
- More than one registered agent adapter, so the Section 10 boundary is exercised rather than
  assumed. An implementation with exactly one adapter is conforming but has not demonstrated
  portability.
- TODO: Persist retry queue and session metadata across process restarts.
- TODO: Make observability settings configurable in workflow front matter without prescribing UI
  implementation details.
- TODO: Extract common semantic helper tools only after multiple adapters demonstrate real
  duplication; do not preemptively replace provider-native tools with generic CRUD.

### 18.3 Operational Validation Before Production (RECOMMENDED)

- Run the `Real Integration Profile` from Section 17.8 with valid credentials and network access.
- Verify hook execution and workflow path resolution on the target host OS/shell environment.
- If the OPTIONAL HTTP server is shipped, verify the configured port behavior and loopback/default
  bind expectations on the target environment.

## Appendix A. SSH Worker Extension (OPTIONAL)

This appendix describes a common extension profile in which Symphony keeps one central
orchestrator but executes worker runs on one or more remote hosts over SSH.

Extension config:

- `worker.ssh_hosts` (list of SSH host strings, OPTIONAL)
  - When omitted, work runs locally.
- `worker.max_concurrent_agents_per_host` (positive integer, OPTIONAL)
  - Shared per-host cap applied across configured SSH hosts.

### A.1 Execution Model

- The orchestrator remains the single source of truth for polling, claims, retries, and
  reconciliation.
- `worker.ssh_hosts` provides the candidate SSH destinations for remote execution.
- Each worker run is assigned to one host at a time, and that host becomes part of the run's
  effective execution identity along with the issue workspace.
- `workspace.root` is interpreted on the remote host, not on the orchestrator host.
<!-- delta: D-020 -->
- The selected agent adapter's subprocess is launched over SSH stdio instead of locally, so the
  orchestrator still owns the session lifecycle even though commands execute remotely.
- This extension therefore composes only with adapters that launch a local subprocess over stdio.
  An adapter that reaches a runtime some other way (an HTTP endpoint, an in-process library) MUST
  state in its profile whether it supports remote workers, and what `workspace.root` and workspace
  confinement mean when it does. An adapter that does not support the extension MUST fail session
  startup with `agent_capability_unsupported` when a worker is assigned to a remote host, rather
  than silently running the agent on the orchestrator host.
- Continuation turns inside one worker lifetime SHOULD stay on the same host and workspace.
<!-- delta: D-020 -->
- A remote host SHOULD satisfy the same basic contract as a local worker environment: reachable
  shell, writable workspace root, whatever runtime the selected agent adapter needs, the values in
  `runner.env`, and any required auth or repository prerequisites.

### A.2 Scheduling Notes

- SSH hosts MAY be treated as a pool for dispatch.
- Implementations MAY prefer the previously used host on retries when that host is still
  available.
- `worker.max_concurrent_agents_per_host` is an OPTIONAL shared per-host cap across configured SSH
  hosts.
- When all SSH hosts are at capacity, dispatch SHOULD wait rather than silently falling back to a
  different execution mode.
- Implementations MAY fail over to another host when the original host is unavailable before work
  has meaningfully started.
- Once a run has already produced side effects, a transparent rerun on another host SHOULD be
  treated as a new attempt, not as invisible failover.

### A.3 Problems to Consider

<!-- delta: D-020 -->
- Remote environment drift:
  - Each host needs the expected shell environment, the agent runtime required by the configured
    `runner.kind`, auth, and repository prerequisites. Changing `runner.kind` changes the
    prerequisites on every host in the pool at once.
- Workspace locality:
  - Workspaces are usually host-local, so moving an issue to a different host is typically a cold
    restart unless shared storage exists.
- Path and command safety:
  - Remote path resolution, shell quoting, and workspace-boundary checks matter more once execution
    crosses a machine boundary.
- Startup and failover semantics:
  - Implementations SHOULD distinguish host-connectivity/startup failures from in-workspace agent
    failures so the same ticket is not accidentally re-executed on multiple hosts.
- Host health and saturation:
  - A dead or overloaded host SHOULD reduce available capacity, not cause duplicate execution or an
    accidental fallback to local work.
- Cleanup and observability:
  - Operators need to know which host owns a run, where its workspace lives, and whether cleanup
    happened on the right machine.

<!-- delta: D-018 -->

## Appendix B. Reference Agent Adapter Profiles

These are the adapter profiles the reference implementation ships, published in the form Section
10.10 requires. They are normative as examples of the profile format and as the behavior of these
specific `runner.kind` values; an implementation is free to ship a different set.

Capability shorthand used below, in fixed order:

`session_continuation / streaming_events / client_tools / approvals / cancellation / usage_reporting / rate_limit_reporting`

### B.1 `codex-app-server`

Reproduces upstream Symphony's behavior exactly. Selecting this adapter and using the legacy
`codex` config block yields an upstream-equivalent deployment.

- Runtime: Codex CLI in app-server mode. Protocol schemas come from the installed Codex version;
  inspect them with `codex app-server generate-json-schema --out <dir>` and read the definitions
  referenced by `v2/ThreadStartParams.json` and `v2/TurnStartParams.json`.
- Default `runner.command`: `codex app-server`
- Transport: newline-delimited JSON-RPC over the subprocess's stdio, stderr kept separate.
- Capabilities: `true / true / true / true / true / true / true`
- `runner.provider` keys, all passed through to Codex without local interpretation:
  - `approval_policy` — Codex `AskForApproval` value
  - `thread_sandbox` — Codex `SandboxMode` value
  - `turn_sandbox_policy` — Codex `SandboxPolicy` value
  - any other key — forwarded verbatim to the corresponding thread/turn start parameter
- Secrets: none of its own; Codex authenticates out of band. `runner.env` MAY carry
  provider credentials.
- Event mapping: `turn/completed` -> `turn_completed`; `turn/failed` -> `turn_failed`;
  `turn/cancelled` -> `turn_cancelled`; approval requests -> `approval_requested` then
  `approval_resolved`; dynamic tool calls -> `tool_call_completed` / `tool_call_failed` /
  `unsupported_tool_call`; `thread/tokenUsage/updated` -> `usage_updated` with
  `mode=cumulative`; user-input requests -> `turn_input_required`; everything else ->
  `notification`.
- Usage mode: `cumulative`. Absolute thread totals are reported; delta-shaped payloads such as
  `last_token_usage` are ignored.
- Approval posture: whatever `approval_policy` and the sandbox fields configure. The adapter
  auto-resolves approval requests according to the implementation's documented policy.

### B.2 `claude-code`

- Runtime: Claude Code CLI in headless streaming mode.
- Default `runner.command`:
  `claude -p --output-format stream-json --input-format stream-json --verbose`
- Transport: newline-delimited JSON over the subprocess's stdio. Turn input is written as a
  stream-json user message; the turn ends on the runtime's terminal result message.
- Capabilities: `true / true / false / false / true / true / false`
- `runner.provider` keys:
  - `model` — model identifier passed to the CLI
  - `permission_mode` — CLI permission mode; the adapter's non-blocking default is documented in
    the implementation
  - `allowed_tools` / `disallowed_tools` — tool allow/deny lists
  - `mcp_config` — path to an MCP configuration file
  - `extra_args` — additional argv appended verbatim
- Secrets: `ANTHROPIC_API_KEY` when the CLI is not already authenticated. Supply it through
  `runner.env` with `$VAR` indirection; the adapter declares it in
  `sensitive_environment_names()`.
- `approvals=false` rationale: the adapter runs the CLI in a mode that never blocks on an
  interactive approval, so approval signals cannot arrive. Access control is expressed with the
  tool allow/deny lists and external sandboxing, not with per-action approvals.
- `client_tools=false` rationale: the CLI reaches host-provided tools through MCP servers rather
  than an inline tool protocol, and this adapter does not host an MCP bridge. Declaring `true` and
  then ignoring advertised tools would be a conformance failure (Section 10.3), so it declares
  `false` and the orchestrator takes the documented fallback. Point `mcp_config` at a tracker MCP
  server to give the agent tracker writes another way, or set `runner.require_client_tools: true`
  to refuse this adapter outright. An adapter that gains an MCP bridge flips the capability; no
  orchestrator change is involved.
- `rate_limit_reporting=false` rationale: the streaming output carries no rate-limit snapshot.
- Event mapping: assistant/tool-progress messages -> `notification`; usage-bearing messages ->
  `usage_updated` with `mode=cumulative`; the terminal result message -> `turn_completed` or
  `turn_failed` by its error flag; a non-zero process exit mid-turn -> `turn_failed` with category
  `agent_exit`.
- Usage mode: `cumulative`.

### B.3 `cli-exec`

The generic escape hatch. Drives any coding agent that has a non-interactive mode: run a command,
give it a prompt, look at the exit code. It exists so that "agent-agnostic" is demonstrable rather
than aspirational — an agent with no streaming protocol, no session model, and no telemetry is still
orchestrable.

- Runtime: any command.
- Default `runner.command`: none; `runner.command` is REQUIRED.
- Transport: none. The prompt is delivered on stdin, or substituted into the command when
  `prompt_arg_placeholder` is configured. Exit code `0` is `completed`; any other exit code is
  `failed`.
- Capabilities: `false / false / false / false / false / false / false`
- `runner.provider` keys:
  - `prompt_delivery` — `stdin` (default) or `argv`
  - `prompt_arg_placeholder` — token replaced by the prompt when `prompt_delivery: argv`
    (default `{{prompt}}`)
  - `success_exit_codes` — list of integers treated as success (default `[0]`)
  - `capture_output_bytes` — maximum stdout/stderr retained for the turn message (default `65536`)
- Secrets: none of its own; use `runner.env`.
- Every capability is `false`, which exercises every fallback in Section 10.3 at once:
  - each turn resends the full rendered prompt, because the command retains nothing;
  - `session_key` is generated once per worker run and reused across turns, so logs stay correlated
    even though each turn is a separate process;
  - the only events are `session_started` and one terminal turn event, so `stall_timeout_ms` caps
    whole-turn wall-clock time;
  - no tools are advertised and `client_tools_unavailable` is emitted once;
  - `stop_session` terminates any in-flight process;
  - token counters stay `0` with `usage_reported=false`.
- Workspace confinement: the command is launched with the workspace as its working directory. The
  adapter cannot confine an agent that chooses to write elsewhere, so deployments using it SHOULD
  add external isolation (Section 15.5).

### B.4 Writing a new adapter

A new adapter is conforming when it:

1. registers a unique `runner.kind`;
2. declares all seven capabilities explicitly, with a stated reason for each `false`;
3. maps every native signal onto the Section 10.6 vocabulary, using `notification` or
   `other_message` for signals with no equivalent;
4. maps native errors onto the Section 10.8 categories;
5. produces a stable non-empty `session_key` for the whole worker run;
6. confines the agent's working directory to the per-issue workspace (Section 9.5);
7. publishes the profile required by Section 10.10;
8. passes the capability-fallback tests in Section 17.5 for every capability it declares `false`.

Nothing in that list requires a change to the orchestrator. If an adapter cannot be added without
one, the abstraction in Section 10 is wrong and this specification is what needs to change.
