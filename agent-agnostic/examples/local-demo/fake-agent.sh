#!/usr/bin/env bash
# A deliberately dumb "coding agent": reads a prompt on stdin, does one unit of work in the
# workspace, and after its second turn moves its own issue to Done in the tracker file.
# No session, no protocol, no telemetry — exactly what `cli-exec` is for.
#
# The workspace directory is named after the issue identifier, which is how it knows what it
# is working on without any orchestrator-specific plumbing.
set -euo pipefail
ISSUE_KEY="$(basename "$PWD")"
prompt="$(cat)"

echo "===== turn $(date -u +%H:%M:%S) =====" >> work.log
echo "$prompt" >> work.log
turns=$(grep -c '^===== turn' work.log)
echo "- work unit $turns for $ISSUE_KEY" >> CHANGELOG.md

if [ "$turns" -ge 2 ]; then
  ISSUE_KEY="$ISSUE_KEY" bun -e '
    const data = await Bun.file(process.env.ISSUES_FILE).json();
    for (const i of data.issues) if (i.identifier === process.env.ISSUE_KEY) i.state = "Done";
    await Bun.write(process.env.ISSUES_FILE, JSON.stringify(data, null, 2));
  '
  echo "$ISSUE_KEY -> Done"
fi
echo "turn $turns complete"
