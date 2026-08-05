#!/usr/bin/env bash
# Put the demo back to its starting state so it can be run again.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf workspaces
git checkout -- issues.json 2>/dev/null || bun -e '
  const d = await Bun.file("issues.json").json();
  for (const i of d.issues) i.state = "Todo";
  await Bun.write("issues.json", JSON.stringify(d, null, 2) + "\n");
'
echo "demo reset"
