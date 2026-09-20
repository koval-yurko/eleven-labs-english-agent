---
name: graphify
description: Use when exploring or answering questions about THIS codebase's structure — where something is defined, how components connect, what the architecture looks like. graphify turns the repo into a queryable code map (tree-sitter AST + an LLM semantic pass over docs/) so you query the graph instead of grepping blind.
---

# graphify — read the map, don't grep blind

`graphify-out/graph.json` covers `apps/`, `packages/shared/` and `supabase/migrations/` (code,
no LLM) plus `docs/` (semantic pass, LLM-extracted and cached — see
`docs/2026-09-19-graffiti-to-graphify-design.md` §6-§7).

## Entry points
- `graphify query "<question>"` — scoped subgraph, prefer this over grep/read.
- `graphify explain "<symbol>"` — plain-language explanation of one node and its neighbors.
- `graphify path "<A>" "<B>"` — shortest path between two nodes.
- `graphify affected "<X>"` — reverse traversal: what breaks if `X` changes.
- `graphify god-nodes` — the most-connected nodes (architectural hubs).

## After editing code
Run `graphify update .` — AST-only, no LLM cost, keeps the graph current for code.

## SQL and docs need extra steps
- `supabase/migrations/*.sql` only shows up if `graphifyy[sql]` is installed
  (`uv tool install "graphifyy[sql]"`) — otherwise those files silently contribute nothing.
- `docs/*.md` only reach the graph through `graphify extract . --backend claude-cli`, which calls
  an LLM. The result is cached and committed (`graphify-out/cache/semantic/`), so re-running it
  after no doc changes costs nothing.

## Querying
Matching is case-folded substring with IDF — no stemming, no synonyms, no cross-language
matching. Query with the graph's own vocabulary: symbol and file names (`resolve_words`,
`resolveWords`), not paraphrases ("word resolution logic").
