#!/usr/bin/env python3
"""Build the suggestion lexicon: one JSONL row per English headword.

Phase 0 of docs/2026-08-15-word-autocomplete-suggestions.md. Joins three open datasets at
build time and writes a single gzipped artifact that `pnpm lexicon:load` puts into Postgres:

    WikDict en-ru.sqlite3   headwords + Russian translations   (CC BY-SA, via DBnary/Wiktionary)
    CEFR-J 1.5 + Octanove   CEFR level where one is known      (TUFS / CC BY-SA 4.0)
    wordfreq                Zipf frequency: inclusion + rank    (CC BY-SA data, MIT code)

Why Python and not tsx like every other script in this repo: `wordfreq` is the frequency source
(§3.2 rejects the alternatives with measurements) and it is Python-only. This script is offline,
one-off, and touches nothing the app owns — it reads three files and writes one. Everything that
touches our own infrastructure (load-lexicon.ts) stays TypeScript.

    pip install -r requirements.txt
    python3 build_lexicon.py --sources ./sources --out data/lexicon.jsonl.gz

The ~21 MB of inputs stay on the build machine — see README.md for where to fetch them. Only the
~1 MB output is committed.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import re
import sqlite3
import sys
import unicodedata
from pathlib import Path

from wordfreq import zipf_frequency

# Words below this Zipf are dropped unless a CEFR list vouches for them. Measured in §3.3:
# 2.5 keeps ubiquitous / serendipity / ephemeral and drops quokka and the proper-noun tail.
ZIPF_FLOOR = 2.5

# The headword shape we accept, tested against the FOLDED key. Internal apostrophes and hyphens
# survive (well-being, o'clock); everything else is Wiktionary artifacts — §3.4 measured ~18k of
# the 96k rows as junk (`#перенаправление another`, `<i>амер.</i> trunk`, `"Kozhevatov"`).
HEADWORD = re.compile(r"^[a-z][a-z' \-]{1,30}$")

# Up to three glosses per row; the full set belongs on the word detail page, not in a dropdown.
MAX_GLOSSES = 3

LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"]

# Wiki markup that leaks into trans_list (621 rows), and the residue that means "give up on this
# gloss" rather than "clean it".
MARKUP = re.compile(r"\[\[|\]\]|\{\{[^}]*\}\}")
UNSALVAGEABLE = re.compile(r"[<>#=/]")


def fold(raw: str) -> str:
    """Approximate `lesson_item_norm_key` (supabase/migrations/0004) — NFKC, unaccent, lower.

    Deliberately an APPROXIMATION, used only for the CEFR join and for dropping junk headwords.
    Postgres computes the real key when the row lands (the `lexicon_set_key` trigger), because
    that key is what the `owned` left-join against `words.norm_key` matches on and there must be
    exactly one implementation of it. Nothing here is written to the artifact as a key.
    """
    decomposed = unicodedata.normalize("NFKD", raw)
    stripped = "".join(c for c in decomposed if not unicodedata.combining(c))
    return unicodedata.normalize("NFKC", stripped).lower().strip()


def clean_glosses(trans_list: str | None) -> list[str]:
    """Pipe-separated Russian → up to three display-ready glosses, best first.

    Stress marks (U+0301, on 7,336 of the 8,308 joined rows) are KEPT: nothing searches on the
    Russian side, and a stressed гла́сный is more useful to a learner than a bare one.
    """
    if not trans_list:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for part in str(trans_list).split("|"):
        gloss = MARKUP.sub("", part).strip()
        if not gloss or UNSALVAGEABLE.search(gloss):
            continue
        # Wiktionary carries the same gloss twice when one copy is stressed: \u0432\u0435\u0437\u0434\u0435\u0441\u0443\u0301\u0449\u0438\u0439 and
        # \u0432\u0435\u0437\u0434\u0435\u0441\u0443\u0449\u0438\u0439 are one word. Compare unstressed; display the first spelling seen,
        # which is the stressed one (trans_list is ordered best-first).
        plain = gloss.replace("\u0301", "")
        if plain in seen:
            continue
        seen.add(plain)
        out.append(gloss)
        if len(out) == MAX_GLOSSES:
            break
    return out


def read_cefr(sources: Path) -> tuple[dict[str, str], dict[str, str]]:
    """Folded headword → (level, source). Lowest (easiest) level wins across both lists."""
    level: dict[str, str] = {}
    source: dict[str, str] = {}
    files = [
        ("cefrj", sources / "cefrj-vocabulary-profile-1.5.csv"),
        ("octanove", sources / "octanove-vocabulary-profile-c1c2-1.0.csv"),
    ]
    for name, path in files:
        if not path.exists():
            sys.exit(f"✗ missing {path} — see scripts/lexicon/README.md for where to fetch it")
        with path.open(encoding="utf-8-sig", newline="") as fh:
            for row in csv.DictReader(fh):
                cefr = (row.get("CEFR") or "").strip().upper()
                if cefr not in LEVELS:
                    continue
                # `a.m./A.M./am/AM` is one row describing four spellings (§3.4).
                for variant in (row.get("headword") or "").split("/"):
                    key = fold(variant)
                    if not key:
                        continue
                    if key not in level or LEVELS.index(cefr) < LEVELS.index(level[key]):
                        level[key] = cefr
                        source[key] = name
    return level, source


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    here = Path(__file__).resolve().parent
    ap.add_argument("--sources", type=Path, default=here / "sources")
    ap.add_argument("--out", type=Path, default=here / "data" / "lexicon.jsonl.gz")
    ap.add_argument("--zipf-floor", type=float, default=ZIPF_FLOOR)
    args = ap.parse_args()

    level, level_source = read_cefr(args.sources)
    print(f"  CEFR: {len(level)} headwords ({sum(1 for v in level_source.values() if v == 'octanove')} from Octanove)")

    dictionary = args.sources / "en-ru.sqlite3"
    if not dictionary.exists():
        sys.exit(f"✗ missing {dictionary} — see scripts/lexicon/README.md")

    con = sqlite3.connect(f"file:{dictionary}?mode=ro", uri=True)
    rows: dict[str, dict] = {}
    stats = {"read": 0, "bad_headword": 0, "no_glosses": 0, "below_floor": 0, "collision": 0}

    for written_rep, trans_list, _importance in con.execute(
        "select written_rep, trans_list, rel_importance from simple_translation"
    ):
        stats["read"] += 1
        text = (written_rep or "").strip()
        key = fold(text)
        if not HEADWORD.match(key):
            stats["bad_headword"] += 1
            continue
        glosses = clean_glosses(trans_list)
        if not glosses:
            stats["no_glosses"] += 1
            continue
        zipf = zipf_frequency(key, "en")
        if zipf < args.zipf_floor and key not in level:
            stats["below_floor"] += 1
            continue

        row = {
            # WikDict's own headword spelling, kept verbatim — it is what goes into the input on
            # select, and `English` / `I` are correctly capitalised there.
            "text": text,
            "zipf": round(zipf, 2),
            "ru": glosses,
            "level": level.get(key),
            "level_source": level_source.get(key),
        }
        # Two spellings can fold to one key (café / cafe). Postgres would resolve this on load
        # anyway; doing it here keeps the artifact one-row-per-word and the count honest.
        if key in rows:
            stats["collision"] += 1
            if row["zipf"] <= rows[key]["zipf"]:
                continue
        rows[key] = row

    con.close()

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(args.out, "wt", encoding="utf-8", newline="\n") as fh:
        for key in sorted(rows):
            fh.write(json.dumps(rows[key], ensure_ascii=False, sort_keys=True) + "\n")

    leveled = sum(1 for r in rows.values() if r["level"])
    no_ru = sum(1 for r in rows.values() if not r["ru"])
    print(
        f"  read {stats['read']} · dropped {stats['bad_headword']} junk headwords, "
        f"{stats['no_glosses']} with no usable RU, {stats['below_floor']} below zipf "
        f"{args.zipf_floor} · {stats['collision']} fold collisions"
    )
    print(f"✅ {len(rows)} rows → {args.out} ({args.out.stat().st_size / 1024:.0f} KB gzipped)")
    print(f"   {leveled} carry a CEFR level ({leveled * 100 // max(len(rows), 1)}%) · {no_ru} have no RU gloss")


if __name__ == "__main__":
    main()
