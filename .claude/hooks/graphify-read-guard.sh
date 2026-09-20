#!/usr/bin/env bash
# Wraps `graphify hook-guard read`. graphify's own read guard
# (_HOOK_SOURCE_EXTS in graphify/cli.py) has no .sql entry, so reads of
# supabase/migrations/*.sql pass through unnudged even though the SQL
# extractor covers them once the `graphifyy[sql]` extra is installed — see
# docs/2026-09-19-graffiti-to-graphify-design.md §5. This script only
# special-cases .sql; every other extension is piped straight to graphify's
# own guard, unmodified.
set -euo pipefail

input="$(cat)"

path="$(node -e '
let d = "";
process.stdin.on("data", c => d += c);
process.stdin.on("end", () => {
  try {
    const j = JSON.parse(d);
    const t = j.tool_input || j;
    process.stdout.write(String(t.file_path || t.path || ""));
  } catch { process.stdout.write(""); }
});
' <<< "$input")"

if [[ "$path" == *.sql ]]; then
  graph="graphify-out/graph.json"
  case "$path" in
    graphify-out/*) exit 0 ;;
  esac
  if [[ -f "$graph" ]]; then
    if [[ -f "$path" && "$path" -nt "$graph" ]]; then
      printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"graphify-out/graph.json exists but may be STALE for this file (the file changed after the last build). Prefer `graphify query \"<question>\"` for orientation, and run `graphify update` to refresh the graph. Reading the file directly is fine."}}'
    else
      printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"MANDATORY: graphify-out/graph.json exists. You MUST run graphify before reading source files. Use: `graphify query \"<question>\"` (scoped subgraph), `graphify explain \"<concept>\"`, or `graphify path \"<A>\" \"<B>\"`. Only read raw files after graphify has oriented you, or to modify/debug specific lines. This rule applies to subagents too — include it in every subagent prompt involving code exploration."}}'
    fi
  fi
  exit 0
fi

printf '%s' "$input" | graphify hook-guard read
