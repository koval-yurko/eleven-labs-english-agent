#!/usr/bin/env bash
# SessionStart staleness check (design doc §8, D11). graphify has no built-in
# signal for doc staleness — `needs_update` is written only by `graphify
# watch`, which this repo doesn't run — so this compares mtimes by hand
# against docs/, README.md and spec/PRD-base.md.
set -euo pipefail

graph="graphify-out/graph.json"
[[ -f "$graph" ]] || exit 0

stale="$(find docs README.md spec/PRD-base.md -newer "$graph" -type f 2>/dev/null | head -1)"
[[ -n "$stale" ]] || exit 0

msg="graphify-out/graph.json is older than $stale. If CI already refreshed the semantic cache, run: git pull. Otherwise: graphify extract . --backend claude-cli"
printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":%s}}\n' \
  "$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$msg")"
