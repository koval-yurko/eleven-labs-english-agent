/**
 * Property checks for `src/shared` — the pure core. Covers the behaviours with a history of
 * breaking or a subtlety worth pinning, not every function.
 *
 * 1. The `/lesson-items` URL grammar round-trips exactly: `parseItemsQuery ∘ serializeItemsQuery`
 *    is the identity over an exhaustive cross-product of every field. This exists because the two
 *    halves used to live in two files and drifted — the encoder omitted `sort` when it equalled
 *    `"practice"` while the decoder defaulted to `"created"`, so choosing "Times practiced"
 *    silently round-tripped back to "Date added". Both directions now read `DEFAULT_SORT` /
 *    `DEFAULT_DIR`; this fails loudly (1500+ cases) if a second default is reintroduced.
 * 2. `searchItems` returns the input array *identity* for an empty term (a no-op search must not
 *    allocate or break `useMemo` referential equality), and matches case-insensitively.
 * 3. `groupFacets` preserves the server's ordering.
 *
 * Run: `pnpm check:shared`
 *
 * NOTE: a stopgap, not a test suite — the repo has no test runner yet. When one is added, these
 * become normal test files and the script goes away. See docs/2026-08-09-shareable-core-refactor.md.
 */
import process from "node:process";
import {
  parseItemsQuery,
  parseSearchTerm,
  searchParamsToBag,
  serializeItemsQuery,
  SORT_KEYS,
  type ItemsQuery,
  type ItemsSearchParams,
} from "./src/items-query";
import { CEFR_LEVELS, ITEM_KINDS, UNLEVELED, type ItemFacet } from "./src/word-types";
import { groupFacets, searchItems } from "./src/item-list";
import { isApiError, isSignedUrlResponse, signedUrlPath } from "./src/api";
import {
  MAX_TRANSCRIPT_LINES,
  MAX_TRANSCRIPT_LINE_CHARS,
  sanitizeTranscript,
} from "./src/tutor";
import {
  buildAddItemsOp,
  buildCreateLessonOp,
  MAX_LESSON_TITLE,
  nextLessonTitle,
  opLessonId,
  parseOutboxRecords,
  planNewItems,
} from "./src/sync-ops";

/**
 * Query string → the bag Next hands a page. Now a THIN wrapper over the shared
 * `searchParamsToBag`, so this suite exercises the exact function `/api/v2/lesson-items` runs rather
 * than a look-alike beside it (S6 D55).
 */
function toSearchParams(qs: string): ItemsSearchParams {
  return searchParamsToBag(new URLSearchParams(qs));
}

const LEVEL_SETS: string[][] = [[], ["B1"], ["C1", UNLEVELED], [...CEFR_LEVELS, UNLEVELED]];
const CATEGORY_SETS: Record<string, string>[] = [
  {},
  { topic: "business" },
  { topic: "business", register: "formal" },
];
const SEARCHES = ["", "ubiq", "two words", "a&b=c?d"];

const failures: string[] = [];
let checked = 0;

for (const levels of LEVEL_SETS)
  for (const favoritesOnly of [false, true])
    for (const kind of [null, ...ITEM_KINDS] as ItemsQuery["kind"][])
      for (const unassignedOnly of [false, true])
        for (const categories of CATEGORY_SETS)
          for (const sort of SORT_KEYS)
            for (const dir of ["asc", "desc"] as const)
              for (const search of SEARCHES) {
                const query: ItemsQuery = {
                  levels,
                  favoritesOnly,
                  kind,
                  unassignedOnly,
                  categories,
                  sort,
                  dir,
                };
                const qs = serializeItemsQuery(query, search);
                const params = toSearchParams(qs);
                const back = parseItemsQuery(params);
                const backSearch = parseSearchTerm(params);
                checked += 1;
                if (JSON.stringify(back) !== JSON.stringify(query) || backSearch !== search) {
                  failures.push(
                    `?${qs}\n  sent ${JSON.stringify({ ...query, search })}\n  got  ${JSON.stringify({ ...back, search: backSearch })}`,
                  );
                }
              }

// The specific regression, named: a non-default sort must survive being serialized and re-parsed.
const practice = parseItemsQuery(
  toSearchParams(serializeItemsQuery({ ...parseItemsQuery({}), sort: "practice" })),
);
if (practice.sort !== "practice") {
  failures.push(`"practice" sort did not survive the round trip (got "${practice.sort}")`);
}

console.log(`checked ${checked} round-trips`);

// ── item-list (R4) ───────────────────────────────────────────────────────────────────────────

const rows = [{ text: "Ubiquitous" }, { text: "café" }, { text: "the ice" }];

// An empty term must return the SAME array, not a copy: `visible` feeds a `useMemo` whose identity
// decides whether the list re-renders, and a fresh array every keystroke would defeat it.
if (searchItems(rows, "") !== rows) failures.push("searchItems: empty term must return the input array identity");
if (searchItems(rows, "   ") !== rows) failures.push("searchItems: whitespace-only term must return the input array identity");

if (searchItems(rows, "UBIQ").length !== 1) failures.push("searchItems: should match case-insensitively");
if (searchItems(rows, "ice").length !== 1) failures.push("searchItems: should match a substring");
if (searchItems(rows, "zzz").length !== 0) failures.push("searchItems: no match should return empty");
// Documented limitation, pinned so a change is deliberate: search is NOT norm_key-aware.
if (searchItems(rows, "cafe").length !== 0) {
  failures.push("searchItems: 'cafe' now matches 'café' — intended? update the note in item-list.ts");
}

const facets: ItemFacet[] = [
  { name: "topic", value: "business", item_count: 3 },
  { name: "topic", value: "travel", item_count: 1 },
  { name: "register", value: "formal", item_count: 2 },
];
const grouped = groupFacets(facets);
if (JSON.stringify(grouped.map(([name, vs]) => [name, vs.length])) !== JSON.stringify([["topic", 2], ["register", 1]])) {
  failures.push(`groupFacets: wrong grouping or order — ${JSON.stringify(grouped.map(([n, v]) => [n, v.length]))}`);
}
if (groupFacets([]).length !== 0) failures.push("groupFacets: empty input should produce no rows");

console.log("checked item-list properties");

// ── sync-ops (R5) ────────────────────────────────────────────────────────────────────────────

/** Deterministic id source, so planned items are comparable. */
function counter(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}
const eq = (label: string, actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
};

// ── items-query: searchParamsToBag ───────────────────────────────────────────────────────────
// Down here only because `eq` is defined here; it belongs to the grammar above. It is now a ROUTE's
// input step (S6 D55), so the repeated-key rule is pinned directly: `?level=B1&level=C1` must become
// an array — that is why `ItemsQuery.levels` is a list — while a single key stays a scalar. A second
// implementation that kept only the last value would silently drop a filter.
eq("searchParamsToBag: single key", searchParamsToBag(new URLSearchParams("sort=text")), { sort: "text" });
eq(
  "searchParamsToBag: repeated key collapses to an array",
  searchParamsToBag(new URLSearchParams("level=B1&level=C1&level=unleveled")),
  { level: ["B1", "C1", "unleveled"] },
);
eq("searchParamsToBag: empty", searchParamsToBag(new URLSearchParams("")), {});

// Normalizes, drops blanks, dedupes within the batch AND against what's already there.
eq(
  "planNewItems: normalize + dedupe",
  planNewItems(["  Ubiquitous ", "", "   ", "ubiquitous", "Don't", "dont", "novel"], [], counter()),
  [
    { id: "id-1", text: "Ubiquitous", position: 0 },
    { id: "id-2", text: "Don't", position: 1 },
    { id: "id-3", text: "dont", position: 2 },
    { id: "id-4", text: "novel", position: 3 },
  ],
);

// "Don't"/"dont" survive as two — clientDedupeKey is deliberately weaker than Postgres `norm_key`,
// which merges them. If this ever becomes one item, the invariant in word-key.ts changed.
// Positions continue from the highest existing one, not from the row count.
eq(
  "planNewItems: positions continue past a gap, existing texts are excluded",
  planNewItems(
    ["novel", "Novel", "fresh"],
    [
      { text: "novel", position: 0 },
      { text: "spare", position: 5 },
    ],
    counter(),
  ),
  [{ id: "id-1", text: "fresh", position: 6 }],
);

if (buildAddItemsOp("L1", ["", "  "], [], counter()) !== null) {
  failures.push("buildAddItemsOp: should be null when nothing survives");
}
if (buildAddItemsOp("L1", ["a"], [{ text: "A", position: 0 }], counter()) !== null) {
  failures.push("buildAddItemsOp: should be null when every text already exists");
}
eq(
  "buildAddItemsOp: shape",
  buildAddItemsOp("L1", ["one", "two"], [], counter()),
  {
    kind: "addItems",
    lessonId: "L1",
    items: [
      { id: "id-1", text: "one", position: 0 },
      { id: "id-2", text: "two", position: 1 },
    ],
  },
);

// The R3-deferred fix: create now dedupes exactly like add did, so the mirror never shows a
// duplicate that the server silently drops.
eq(
  "buildCreateLessonOp: dedupes and caps the title",
  buildCreateLessonOp("L1", "  " + "t".repeat(200) + "  ", ["one", "One", "two"], counter()),
  {
    kind: "createLesson",
    lesson: {
      id: "L1",
      title: "t".repeat(MAX_LESSON_TITLE),
      items: [
        { id: "id-1", text: "one" },
        { id: "id-2", text: "two" },
      ],
    },
  },
);

const JAN_5 = new Date(2026, 0, 5);
eq("nextLessonTitle: free", nextLessonTitle(new Set(), JAN_5), "05-01-2026");
eq("nextLessonTitle: taken", nextLessonTitle(new Set(["05-01-2026"]), JAN_5), "05-01-2026 1");
eq(
  "nextLessonTitle: several taken",
  nextLessonTitle(new Set(["05-01-2026", "05-01-2026 1", "05-01-2026 2"]), JAN_5),
  "05-01-2026 3",
);

eq("opLessonId: createLesson", opLessonId({ kind: "createLesson", lesson: { id: "L1", title: "t", items: [] } }), "L1");
eq("opLessonId: addItems", opLessonId({ kind: "addItems", lessonId: "L2", items: [] }), "L2");
eq("opLessonId: removeItem", opLessonId({ kind: "removeItem", lessonId: "L3", itemId: "i" }), "L3");
eq("opLessonId: deleteLesson", opLessonId({ kind: "deleteLesson", lessonId: "L4" }), "L4");

// `parseOutboxRecords` — the guard the /api/v2/sync/flush route narrows an untrusted body with.
// The `kind: "nonsense"` case is the one that matters: `applyOp`'s switch has no `default`, so
// without this guard such a record is silently REPORTED AS APPLIED (D46).
const goodRecord = {
  id: "r1",
  seq: 1,
  createdAt: "2026-08-14T00:00:00.000Z",
  op: { kind: "removeItem", lessonId: "L1", itemId: "i1" },
};

eq("parseOutboxRecords: empty batch", parseOutboxRecords([]), []);
eq("parseOutboxRecords: accepts a well-formed batch", parseOutboxRecords([goodRecord]), [goodRecord]);
eq(
  "parseOutboxRecords: accepts every op kind",
  parseOutboxRecords([
    { ...goodRecord, op: { kind: "createLesson", lesson: { id: "L1", title: "t", items: [{ id: "i1", text: "a" }] } } },
    { ...goodRecord, op: { kind: "addItems", lessonId: "L1", items: [{ id: "i1", text: "a", position: 0 }] } },
    { ...goodRecord, op: { kind: "removeItem", lessonId: "L1", itemId: "i1" } },
    { ...goodRecord, op: { kind: "deleteLesson", lessonId: "L1" } },
  ])?.length,
  4,
);

const rejected: [string, unknown][] = [
  ["not an array", goodRecord],
  ["null", null],
  ["unknown op kind", [{ ...goodRecord, op: { kind: "nonsense", lessonId: "L1" } }]],
  ["missing op", [{ id: "r1", seq: 1, createdAt: "x" }]],
  ["missing seq", [{ id: "r1", createdAt: "x", op: goodRecord.op }]],
  ["empty record id", [{ ...goodRecord, id: "" }]],
  ["removeItem without itemId", [{ ...goodRecord, op: { kind: "removeItem", lessonId: "L1" } }]],
  ["addItems with a non-array items", [{ ...goodRecord, op: { kind: "addItems", lessonId: "L1", items: "a" } }]],
  ["addItems item without a position", [
    { ...goodRecord, op: { kind: "addItems", lessonId: "L1", items: [{ id: "i1", text: "a" }] } },
  ]],
  ["createLesson without a title", [
    { ...goodRecord, op: { kind: "createLesson", lesson: { id: "L1", items: [] } } },
  ]],
];
for (const [label, body] of rejected) {
  if (parseOutboxRecords(body) !== null) failures.push(`parseOutboxRecords: should reject ${label}`);
}

// All-or-nothing: one bad member rejects the batch rather than applying a prefix of it.
if (parseOutboxRecords([goodRecord, { ...goodRecord, op: { kind: "nonsense" } }]) !== null) {
  failures.push("parseOutboxRecords: one bad member must reject the whole batch");
}

console.log("checked sync-ops properties");

// ── transcript (R6) ──────────────────────────────────────────────────────────────────────────

eq("sanitizeTranscript: non-array input", sanitizeTranscript(undefined), []);
eq("sanitizeTranscript: null input", sanitizeTranscript(null), []);
eq(
  "sanitizeTranscript: drops malformed turns",
  sanitizeTranscript([
    { role: "agent", text: "hello" },
    { role: "system", text: "nope" }, // unknown role
    { role: "user", text: 42 }, // non-string text
    null,
    { role: "user", text: "hi" },
  ]),
  [
    { role: "agent", text: "hello" },
    { role: "user", text: "hi" },
  ],
);
eq(
  "sanitizeTranscript: preserves timeInCallSecs (the webhook's only extra field)",
  sanitizeTranscript([{ role: "agent", text: "x", timeInCallSecs: 12 }]),
  [{ role: "agent", text: "x", timeInCallSecs: 12 }],
);

const longLine = sanitizeTranscript([{ role: "user", text: "z".repeat(MAX_TRANSCRIPT_LINE_CHARS + 50) }]);
if (longLine[0]?.text.length !== MAX_TRANSCRIPT_LINE_CHARS) {
  failures.push(`sanitizeTranscript: line not capped (${longLine[0]?.text.length})`);
}

const many = Array.from({ length: MAX_TRANSCRIPT_LINES + 25 }, () => ({ role: "user", text: "a" }));
if (sanitizeTranscript(many).length !== MAX_TRANSCRIPT_LINES) {
  failures.push(`sanitizeTranscript: line count not capped (${sanitizeTranscript(many).length})`);
}

// Documented ordering: the count cap applies BEFORE the validity filter, so malformed entries
// inside the first MAX_TRANSCRIPT_LINES consume budget. Pinned so a "cleanup" is deliberate.
const mixed = [
  ...Array.from({ length: MAX_TRANSCRIPT_LINES }, (_, i) =>
    i % 2 === 0 ? { role: "user", text: "a" } : { role: "bogus", text: "a" },
  ),
  { role: "agent", text: "past the cap" },
];
if (sanitizeTranscript(mixed).length !== MAX_TRANSCRIPT_LINES / 2) {
  failures.push("sanitizeTranscript: cap-before-filter ordering changed — intended?");
}

console.log("checked transcript properties");

// ── api (R7) ─────────────────────────────────────────────────────────────────────────────────

eq("signedUrlPath: no version", signedUrlPath(), "/api/words-agent/signed-url");
eq(
  "signedUrlPath: encodes the version",
  signedUrlPath("words 1.3/beta"),
  "/api/words-agent/signed-url?version=words%201.3%2Fbeta",
);

if (!isApiError({ error: { code: "config", message: "boom" } })) {
  failures.push("isApiError: should accept a well-formed envelope");
}
for (const notAnError of [null, undefined, "boom", {}, { error: null }, { error: {} }, { ok: true }]) {
  if (isApiError(notAnError)) failures.push(`isApiError: wrongly accepted ${JSON.stringify(notAnError)}`);
}

if (!isSignedUrlResponse({ signedUrl: "wss://x", version: "words-1.3", appEnv: "dev" })) {
  failures.push("isSignedUrlResponse: should accept a complete response");
}
// appEnv is REQUIRED: it routes the post-call webhook to an environment, so a missing one must
// surface as an error rather than silently defaulting a dev session into prod.
for (const bad of [
  { signedUrl: "wss://x", version: "v" }, // no appEnv
  { signedUrl: "", appEnv: "dev" }, // empty url
  { appEnv: "dev" },
  { error: { code: "config", message: "no key" } },
  null,
]) {
  if (isSignedUrlResponse(bad)) failures.push(`isSignedUrlResponse: wrongly accepted ${JSON.stringify(bad)}`);
}

console.log("checked api properties");

if (failures.length > 0) {
  console.error(`FAILED: ${failures.length}`);
  console.error(failures.slice(0, 5).join("\n---\n"));
  process.exit(1);
}
console.log("shared core: all properties hold");
