---
# Example WORKFLOW.md for the agent-agnostic Symphony implementation.
#
# Copy this into the repository you want Symphony to work on, adjust it, and run:
#   bun run start /path/to/WORKFLOW.md --port 4000
#
# Everything below the front matter is the per-issue prompt template. It is rendered with strict
# Liquid semantics: an unknown variable or filter fails the run rather than silently producing an
# empty string.

tracker:
  kind: github
  provider:
    repository: your-org/your-repo
    token: $GITHUB_TOKEN
    # GitHub issues are only open/closed, so workflow states ride on labels:
    #   "status:In Progress"  ->  state "In Progress"
    state_label_prefix: "status:"
    default_open_state: Todo
    closed_state: Done
    require_assignee: false
  required_labels:
    - symphony
  active_states:
    - Todo
    - In Progress
    - Rework
  terminal_states:
    - Done
    - Cancelled

polling:
  interval_ms: 30000

workspace:
  root: ~/symphony-workspaces

hooks:
  # Runs once, when the workspace directory is first created. A failure aborts creation.
  after_create: |
    git clone --depth 1 https://github.com/your-org/your-repo .
  # Runs before every attempt. A failure aborts that attempt.
  before_run: |
    git fetch --all --prune
  # Runs after every attempt. Failures are logged and ignored.
  after_run: |
    git status --short

agent:
  max_concurrent_agents: 4
  max_turns: 20
  max_retry_backoff_ms: 300000
  max_concurrent_agents_by_state:
    "in progress": 2

# ---------------------------------------------------------------------------
# The agent runtime. `kind` selects one registered adapter; `provider` is owned by that adapter and
# passed through untouched. Swapping coding agents means editing this block and nothing else.
# ---------------------------------------------------------------------------
runner:
  kind: codex-app-server
  command: codex app-server
  provider:
    approval_policy: never
    thread_sandbox: workspace-write
    turn_sandbox_policy:
      type: workspaceWrite
      networkAccess: true
  # Extra environment for the agent child process. Use $VAR references, never literals.
  env: {}
  # Fail dispatch rather than silently running without host-executed tracker tools.
  require_client_tools: true
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000

# --- Alternative: Claude Code -----------------------------------------------
# runner:
#   kind: claude-code
#   provider:
#     model: claude-opus-4-5
#     permission_mode: bypassPermissions
#     mcp_config: ./mcp.json     # how this agent reaches tracker tools; see Appendix B.2
#   env:
#     ANTHROPIC_API_KEY: $ANTHROPIC_API_KEY

# --- Alternative: any command with a headless mode --------------------------
# runner:
#   kind: cli-exec
#   command: my-agent --workspace . --prompt-from-stdin
#   provider:
#     prompt_delivery: stdin
#     success_exit_codes: [0]

# OPTIONAL HTTP observability server. `--port` on the CLI overrides this.
server:
  port: 4000
---

You are working on issue `{{ issue.identifier }}` in an unattended orchestration session.

{% if attempt %}
This is follow-up attempt #{{ attempt }}. It may be a normal continuation or a retry after a
failure. Resume from the current workspace state instead of starting over, and do not repeat
investigation or validation you have already completed.
{% endif %}

## Issue

- Identifier: {{ issue.identifier }}
- Title: {{ issue.title }}
- State: {{ issue.state }}
- Labels: {{ issue.labels | default: "none" }}
- URL: {{ issue.url | default: "none" }}

{% if issue.blocked_by %}
Blocked by:
{% for blocker in issue.blocked_by %}
- {{ blocker.identifier | default: blocker.id }} ({{ blocker.state | default: "unknown state" }})
{% endfor %}
{% endif %}

### Description

{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided. Infer the intent from the title, and record your interpretation before
making changes.
{% endif %}

## Rules

1. Work only inside this workspace directory. Do not touch any other path.
2. No human is watching. Do not ask for follow-up actions or wait for input.
3. Stop early only for a true external blocker: missing tools, credentials, or permissions. Record
   the blocker and move the issue to the state your workflow uses for blocked work.
4. When the work is complete, move the issue to the next handoff state. Reaching that handoff — not
   reaching `Done` — is what success means here.
5. Your final message should report what you completed and what is blocked. Do not include a
   "next steps for the user" section.
