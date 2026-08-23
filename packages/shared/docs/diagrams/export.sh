#!/usr/bin/env bash
# Regenerate every .svg from the .drawio beside it.
#
# The .drawio is the source: open it in draw.io, edit it, save, then run this.
# The .svg is generated and must never be hand-edited.
set -euo pipefail
cd "$(dirname "$0")"

DRAWIO=${DRAWIO:-$(command -v drawio || echo /Applications/draw.io.app/Contents/MacOS/draw.io)}
[ -x "$DRAWIO" ] || { echo "draw.io CLI not found — set DRAWIO=/path/to/drawio" >&2; exit 1; }

for src in *.drawio; do
  out="${src%.drawio}.svg"
  # --theme light            pin the colours; without it draw.io emits CSS light-dark(), whose
  #                          dark half renders pale text on the white panel below.
  # --embed-svg-fonts false  the font stack added below resolves everywhere; embedding costs ~300KB.
  # -e                       keep the diagram XML inside the SVG, so the export stays editable.
  "$DRAWIO" -x -f svg -e -b 12 --theme light --embed-svg-fonts false -o "$out" "$src" >/dev/null

  # Two fixes, whole-file: give both font families a stack that resolves off macOS, and paint the
  # panel — a transparent SVG puts dark text on a dark README background.
  perl -0pi -e '
    s/Helvetica/Helvetica, Arial, sans-serif/g;
    s/\x27Courier New\x27/\x27Courier New\x27, ui-monospace, monospace/g;
    s{(<svg\b[^>]*>)}{$1<rect width="100%" height="100%" fill="#ffffff"/>}s;
  ' "$out"

  printf '  %-28s %sK\n' "$out" "$(( $(wc -c <"$out") / 1024 ))"
done
echo "$(ls -1 *.drawio | wc -l | tr -d ' ') diagrams regenerated"
