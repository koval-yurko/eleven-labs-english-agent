---
name: diagrams
description: "INVOKE THIS SKILL before creating, editing, or reviewing any diagram that ships as a file in this repo — architecture, data-flow, decision-logic, state, or sequence pictures in docs/ or packages/*/docs/. Read it BEFORE drawing. Covers what the bundled artifact-diagramming skill does not: using real values, the cut test, and this repo's Mermaid/draw.io mechanics."
---

# Diagrams committed to this repo

**First load the bundled `artifact-diagramming` skill** for the general judgment — when a picture
earns its place, mechanism over label, labelled arrows, one figure one claim. It is not restated
here, so it cannot drift.

Two warnings about it:

- Its description scopes it to published Artifacts, so it will not surface on its own for repo
  documentation. That is why this file exists.
- **Ignore its "Inline SVG mechanics" section here.** It says hand-author inline `<svg>` with no
  `<foreignObject>` and no external images. That is right for an Artifact and wrong for us: our
  diagrams are external `.svg` files exported by draw.io (which emit `foreignObject` inside a
  `<switch>`), and GitHub Markdown sanitizes inline SVG anyway.

What follows is only what that skill does not cover.

## 1. Use real values

The biggest single difference between a useful diagram and a restated outline. Concrete strings,
ids, payloads — never a verb standing in for the data.

> **BAD** — a box reading `wordInputKey() trim + cap at 500`.
> That is the function's *name*. The prose beside it said the same thing faster.

> **GOOD** — two real inputs walked through the system:
> `Café` and `cafe` → two different `clientDedupeKey` values → *so both get sent* → `unaccent` →
> **one** `word id` → the `linked` guard absorbs the second.
> The reader now *sees* why the client over-counts, and why that guard has to exist.

Ten diagrams were deleted from `packages/shared/docs` in 2026-08 for failing this rule.

## 2. Show the consequence

End on what breaks without the step, or which of N outcomes gets chosen. A flow that just arrives
somewhere teaches nothing.

## 3. The cut test

Before drawing, write the sentence the diagram would replace. If the sentence is as clear, ship the
sentence. Applied here that removed six of ten: a generic request flow, a list of test harnesses,
and a colour table were all better as prose or a Markdown table.

What earns a picture in this repo:

- **asymmetries** — client vs Postgres normalization
- **decisions with more than two outcomes** — which resume message a held pause earns
- **failure and recovery paths** — a flush dying mid-way, then replaying to the same state
- **layering rules** — who may not import whom

## 4. Mechanics here

Diagrams live in a `diagrams/` folder beside the doc that uses them.

- **Mermaid** — preferred for anything a fenced block can express. GitHub renders ```mermaid
  natively in `.md`, VS Code previews it, and it lives in the diff as text with no build step.
- **draw.io** — only for layouts Mermaid cannot place. Keep `name.drawio` (source) beside
  `name.svg` (generated); regenerate with `packages/shared/docs/diagrams/export.sh`. Never
  hand-edit the SVG.

Three export flags are load-bearing, and a hand-run `drawio -x` will not match without them:
`--theme light` (else draw.io emits CSS `light-dark()` that goes pale on the white panel), an
injected white background `<rect>` (a transparent SVG puts dark text on a dark README), and
plain-text rather than HTML labels (HTML labels make draw.io embed a base64 PNG of every label —
~300 KB per file, 3.9 MB across ten — and those rasters are what `<img>` context falls back to).

Any generator script must write relative to itself, never to an absolute repo path: an absolute one
wrote 20 files into the main checkout while the branch was open in a worktree.

## 5. Before you finish

Render it and **look at it**. Check that no edge crosses a box, no label overlaps a shape, and no
arrow implies a dependency that does not exist — an annotation arrow pointing at `theme.ts` reads
as "theme imports this", the opposite of the truth. Both defects shipped once.
