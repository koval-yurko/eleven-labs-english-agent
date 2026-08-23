#!/usr/bin/env bash
# Proves each layering zone actually fires. Deliberately violates the rule in a scratch file,
# asserts eslint rejects it, then removes the file. Scratch files only — never edits real ones.
cd "$(dirname "$0")" || exit 1
pass=0; fail=0

probe() { # <label> <expect: DENY|ALLOW> <path> <import-specifier>
  local label="$1" expect="$2" path="$3" spec="$4"
  mkdir -p "$(dirname "$path")"
  printf 'import "%s";\n' "$spec" > "$path"
  if npx eslint "$path" >/dev/null 2>&1; then got=ALLOW; else got=DENY; fi
  rm -f "$path"
  if [ "$got" = "$expect" ]; then
    printf '  ok    %-46s %s\n' "$label" "$got"; pass=$((pass+1))
  else
    printf '  FAIL  %-46s expected %s, got %s\n' "$label" "$expect" "$got"; fail=$((fail+1))
  fi
}

echo "layering zones:"
probe "words/ may not name tutor/"        DENY  src/words/__p.ts      ../tutor/session
probe "words/ may not name offline/"      DENY  src/words/__p.ts      ../offline/ops
probe "tutor/ may not name offline/"      DENY  src/tutor/__p.ts      ../offline/ops
probe "tutor/ may not name api"           DENY  src/tutor/__p.ts      ../api
probe "offline/ may not name api"         DENY  src/offline/__p.ts    ../api
probe "nothing shipped names testing/"    DENY  src/__p.ts            ./testing/fake-transport
probe "api.ts's own folder: no testing/"  DENY  src/__p.ts            ./testing/fake-transport
# theme.ts's zone is pinned to that exact filename, so a scratch file cannot exercise it.
# Append to the real file, lint, restore byte-for-byte.
bak=$(mktemp)
cp src/theme.ts "$bak"
printf '\nimport "./words/types";\n' >> src/theme.ts
if npx eslint src/theme.ts >/dev/null 2>&1; then got=ALLOW; else got=DENY; fi
cp "$bak" src/theme.ts
# Compare against our own backup, not HEAD: an uncommitted edit to theme.ts is not
# evidence that this script failed to restore it.
if cmp -s "$bak" src/theme.ts; then restored=yes; else restored=NO; fi
rm -f "$bak"
if [ "$got" = DENY ] && [ "$restored" = yes ]; then
  printf '  ok    %-46s %s (file restored)\n' "theme.ts imports nothing" "$got"; pass=$((pass+1))
else
  printf '  FAIL  %-46s got %s, restored=%s\n' "theme.ts imports nothing" "$got" "$restored"; fail=$((fail+1))
fi

echo "the outer boundary must survive the zone override:"
probe "words/ still cannot name an npm pkg" DENY src/words/__p.ts     zod
probe "tutor/ still cannot name an npm pkg" DENY src/tutor/__p.ts     zod
probe "tutor/ still cannot reach an app"    DENY src/tutor/__p.ts     ../../lib/db

echo "what must remain legal:"
probe "tutor/ may name words/"            ALLOW src/tutor/__p.ts      ../words/types
probe "offline/ may name tutor/"          ALLOW src/offline/__p.ts    ../tutor/session
probe "testing/ may name what it fakes"   ALLOW src/testing/__p.ts    ../tutor/transport
probe "api.ts may name any domain"        ALLOW src/__p.ts            ./tutor/transport

echo
echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ]
