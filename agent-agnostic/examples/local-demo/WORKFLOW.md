---
# A self-contained demo workflow. See README.md in this directory.
#
# `$DEMO_DIR` is expanded from the environment: provider values go through Symphony's `$VAR`
# resolution, and `runner.command` is expanded by the shell that launches the agent.

tracker:
  kind: memory
  provider:
    path: $DEMO_DIR/issues.json
  required_labels: [symphony]
  active_states: [Todo, In Progress]
  terminal_states: [Done, Cancelled]

polling:
  interval_ms: 2000

workspace:
  # Relative paths resolve against the directory holding this file.
  root: ./workspaces

hooks:
  after_create: |
    git init -q . && echo "# workspace for $(basename $PWD)" > README.md

agent:
  max_concurrent_agents: 2
  max_turns: 5

runner:
  kind: cli-exec
  command: $DEMO_DIR/fake-agent.sh
  env:
    ISSUES_FILE: $DEMO_DIR/issues.json
  provider:
    prompt_delivery: stdin
  stall_timeout_ms: 30000

server:
  port: 4477
---

You are working on {{ issue.identifier }}: {{ issue.title }}

State: {{ issue.state }} | Labels: {{ issue.labels }}
{% if attempt %}Follow-up attempt #{{ attempt }}.{% endif %}

{{ issue.description }}
