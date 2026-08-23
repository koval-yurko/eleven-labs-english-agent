# Diagrams

Most diagrams in this package are **Mermaid**, written inline in the doc that uses them: they render
on GitHub and in VS Code, diff as text, and need no build step. Only two live here as files, because
they place monospace columns and a cross-lane failure path that auto-layout cannot arrange.

| file | the claim it makes |
| --- | --- |
| `tutor-pause` | three real pauses, three different things the tutor owes on return — chosen by the transcript, not the clock |
| `offline-write` | one `transact`, a flush that dies after two of three records, and a replay that lands on identical rows |

## Which tool

**Mermaid** for anything a fenced block can express — that is the default. Reach for **draw.io** only
when auto-layout puts the punchline in the wrong place: parallel columns meant to be read across,
routed failure paths, anything where position carries meaning. Two of seven qualified.

The test either way: write the sentence the diagram would replace, and only draw it if the sentence
is worse. What survives is asymmetries, decisions with more than two outcomes, failure and its
recovery, and layering rules — and every box carries real values, never a function name the prose
already used. Ten diagrams were cut from this folder in 2026-08 for failing that test. The repo skill
in [`.claude/skills/diagrams`](../../../../.claude/skills/diagrams/SKILL.md) is the long version.

## Editing one

`name.drawio` is the **source**. `name.svg` is generated and must never be hand-edited.

```bash
open tutor-pause.drawio    # edit it in the draw.io desktop app, save,
./export.sh                # then regenerate every .svg from its .drawio
```

`export.sh` needs the draw.io desktop app; point `DRAWIO=` at the binary if it is not on `PATH`.
Both files are committed. There is no generator script and no spec format — what you see in draw.io
is the whole source.

## Why the export flags look the way they do

Four things are deliberate, and a hand-run `drawio -x` will not match without them:

- **`--theme light`** pins the colours. Without it draw.io emits CSS `light-dark()`, whose dark half
  renders pale text on the white panel below.
- **A white `<rect>` is injected** as the first child. A transparent SVG puts dark text on a dark
  README background.
- **Plain-text labels (`html=0`), not HTML labels.** With HTML labels draw.io embeds a base64 PNG
  raster of every label as a `<switch>` fallback — ~300 KB per file — and that raster is what
  actually renders when Markdown loads an SVG through `<img>`.
- **`--embed-svg-fonts false`**, with the font stack widened afterwards, so the files stay small and
  still resolve off macOS.

Inside the `.drawio`, two more: newlines in a label must be `&#10;` (an XML parser normalizes a
literal newline in an attribute to a space, so hand-placed line breaks vanish and draw.io re-wraps by
width), and runs of two or more spaces must be non-breaking (SVG collapses whitespace, so aligned
columns vanish). Boxes quoting code or a transcript use `fontFamily=Courier New` and `align=left`: a
centred transcript cannot be read down.

## Before you commit one

Render it and **look at it**. Check that no edge crosses a box, no label overlaps a shape, and no
arrow implies a dependency that does not exist — an annotation arrow pointing at a module reads as
"this module imports it", often the opposite of the truth. Both defects shipped once.
