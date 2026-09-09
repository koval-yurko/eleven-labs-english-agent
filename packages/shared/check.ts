/** Property checks for the pure core — the behaviours with a history of breaking.
 *  Run with `pnpm check:shared`. See README.md#testing. */
import process from "node:process";
import {
  parseItemsQuery,
  parseSearchTerm,
  searchParamsToBag,
  serializeItemsQuery,
  SORT_KEYS,
  type ItemsQuery,
  type ItemsSearchParams,
} from "./src/words/query";
import { CEFR_LEVELS, ITEM_KINDS, UNLEVELED, type ItemFacet } from "./src/words/types";
import { groupFacets, searchItems } from "./src/words/list";
import { isApiError, isSignedUrlResponse, signedUrlPath } from "./src/api";
import { CSS_VARIABLES, DARK, LIGHT, paletteFor, parseScheme, type Palette } from "./src/theme";
import {
  ABORTED_RESUME_MESSAGE,
  MAX_TRANSCRIPT_LINES,
  MAX_TRANSCRIPT_LINE_CHARS,
  PAUSE_STOP_MESSAGE,
  UNHEARD_RESUME_MESSAGE,
  sanitizeTranscript,
  type TranscriptLine,
} from "./src/tutor/session";
import { applyHold, applyRelease, planHold, planRelease } from "./src/tutor/pause";
import {
  MAX_DEBUG_DATA_KEYS,
  MAX_DEBUG_DATA_VALUE,
  MAX_DEBUG_EVENTS,
  MAX_DEBUG_MESSAGE,
  MAX_DEBUG_NOTE,
  MAX_DEBUG_TRANSCRIPT_TAIL,
  MAX_REPORT_BYTES,
  redactValue,
  sanitizeDebugReport,
  trimDebugEvents,
  type DebugEvent,
  type DebugLevel,
} from "./src/debug/report";
import { DEBUG_CODES, isKnownDebugCode } from "./src/debug/codes";
import { createFakeTransport } from "./src/testing/fake-transport";
import type { TutorCapabilities } from "./src/tutor/transport";
import {
  buildAddItemsOp,
  buildCreateLessonOp,
  MAX_LESSON_TITLE,
  nextLessonTitle,
  opLessonId,
  parseOutboxRecords,
  planNewItems,
} from "./src/offline/ops";

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
  for (const kind of [null, ...ITEM_KINDS] as ItemsQuery["kind"][])
    for (const unassignedOnly of [false, true])
      for (const categories of CATEGORY_SETS)
        for (const sort of SORT_KEYS)
          for (const dir of ["asc", "desc"] as const)
            for (const search of SEARCHES) {
              const query: ItemsQuery = {
                levels,
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
// Search folds like `lexiconPrefixFold` now, so it IS accent-aware — the inverse of what this
// line used to pin. Kept pinned in the new direction: it is the reason the box finds "café".
if (searchItems(rows, "cafe").length !== 1) {
  failures.push("searchItems: 'cafe' must match 'café' — the fold is what makes search norm-aware");
}

// ── typo tolerance ───────────────────────────────────────────────────────────────────────────
// The budget ladder (0 edits below 4 chars, 1 up to 6, 2 beyond) is the whole behaviour, so each
// rung is pinned. A change to `editBudget` that is not deliberate fails here.
if (searchItems(rows, "ubiqutous").length !== 1) failures.push("searchItems: one deletion should still match");
if (searchItems(rows, "ubiquitious").length !== 1) failures.push("searchItems: one insertion should still match");
if (searchItems(rows, "ubiqu").length !== 1) failures.push("searchItems: a typed prefix should match");
if (searchItems(rows, "ubiqi").length !== 1) failures.push("searchItems: a typo inside a typed prefix should match");
// 3 edits from "ubiquitous" at 9 characters, where the budget is 2. Mean on purpose.
if (searchItems(rows, "ubqitos").length !== 0) failures.push("searchItems: 3 edits must not match — the budget is 2");
// Below four characters the budget is zero: "abc" must not drag in every three-letter neighbour.
if (searchItems(rows, "ubq").length !== 0) failures.push("searchItems: needles under 4 chars must be exact");
// Substring still matches anywhere ("quitous" is literally inside "ubiquitous") — it is the FUZZY
// pass that is anchored to a token's start, so a mid-word needle with a typo in it does not match.
if (searchItems(rows, "quitous").length !== 1) failures.push("searchItems: substring match is not anchored");
if (searchItems(rows, "quitious").length !== 0) {
  failures.push("searchItems: the fuzzy pass must be anchored at a token start, not floating");
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

// ── theme (R8) ───────────────────────────────────────────────────────────────────────────────
// The palettes drifted once already: LIGHT was byte-identical across the two apps while DARK
// differed on EVERY value, because each client held its own copy. One table now, and these checks
// pin the three ways a role can go missing from it.

// 1. Both appearances define every role, with a real colour. A `Palette` with a key omitted is a
//    type error; a key present but empty is not, and it renders as "inherit" rather than as a crash.
const ROLES = Object.keys(CSS_VARIABLES) as (keyof Palette)[];
for (const [name, palette] of [
  ["DARK", DARK],
  ["LIGHT", LIGHT],
] as const) {
  for (const role of ROLES) {
    if (!/^#[0-9a-f]{6}$/.test(palette[role])) {
      failures.push(`theme: ${name}.${role} is not a 6-digit lowercase hex (got ${JSON.stringify(palette[role])})`);
    }
  }
  if (Object.keys(palette).length !== ROLES.length) {
    failures.push(`theme: ${name} has ${Object.keys(palette).length} keys, CSS_VARIABLES has ${ROLES.length}`);
  }
}

// 2. Every role publishes under a distinct CSS custom property. Two roles sharing a variable is the
//    silent failure the web would show as one of them simply never applying.
const varNames = new Set(Object.values(CSS_VARIABLES));
if (varNames.size !== ROLES.length) {
  failures.push(`theme: CSS_VARIABLES maps ${ROLES.length} roles onto ${varNames.size} variables`);
}
for (const [role, name] of Object.entries(CSS_VARIABLES)) {
  if (!name.startsWith("--")) failures.push(`theme: CSS_VARIABLES.${role} = ${name} is not a custom property`);
}

// 3. The stored-preference rule is the SAME on both clients: only the literal "light" opts out of
//    dark. The web re-spells this inside its pre-paint script (which must run before the bundle),
//    so a change here that is not mirrored there is exactly the bug worth catching.
eq("parseScheme: light", parseScheme("light"), "light");
for (const stored of [null, undefined, "", "dark", "system", "Light", "LIGHT", "true"]) {
  eq(`parseScheme: ${JSON.stringify(stored)} resolves dark`, parseScheme(stored), "dark");
}
eq("paletteFor: light", paletteFor("light"), LIGHT);
eq("paletteFor: dark", paletteFor("dark"), DARK);

// 4. The two appearances are actually different. A copy-paste that left LIGHT equal to DARK would
//    pass everything above.
if (JSON.stringify(LIGHT) === JSON.stringify(DARK)) {
  failures.push("theme: LIGHT and DARK are identical");
}

console.log("checked theme properties");


// ── the held pause ───────────────────────────────────────────────────────────────────────────
// The highest-risk logic in the app and, until it was split into `planHold`/`planRelease`, the only
// logic that could not be checked without a phone and a billed session. Getting it wrong is
// invisible on screen — the tutor just says the wrong thing, plausibly.
// See docs/2026-08-16-tutor-pause-hold-the-line.md and 2026-08-17-short-turns-and-chunked-pause.md.

const CAPS = (over: Partial<TutorCapabilities> = {}): TutorCapabilities => ({
  silenceOutput: true,
  userActivity: true,
  cancelTurn: true,
  responseCorrection: true,
  ...over,
});

let pauseCases = 0;
const agentLine: TranscriptLine = { role: "agent", text: "…and that's ephemeral." };
const userLine: TranscriptLine = { role: "user", text: "got it" };

// 1. THE INVARIANTS, over the full cross-product of what the pause depends on.
for (const speaking of [false, true])
  for (const cancelTurn of [false, true])
    for (const userActivity of [false, true])
      for (const wasMuted of [false, true])
        for (const after of [[], [userLine], [agentLine], [userLine, agentLine]]) {
          const caps = CAPS({ cancelTurn, userActivity });
          const label = `pause[speaking=${speaking} cancel=${cancelTurn} activity=${userActivity} muted=${wasMuted} after=${after.length}]`;
          const hold = planHold(caps, { speaking, muted: wasMuted, lineCount: 2, at: 1_000 });

          // Barging in happens if and only if there was a turn to interrupt. Barging into silence
          // would only provoke one.
          eq(`${label}: bargeIn`, hold.bargeIn !== "none", speaking);
          // And which mechanism is the PROVIDER's answer, never this rule's guess.
          if (speaking) eq(`${label}: mechanism`, hold.bargeIn, cancelTurn ? "cancel" : "message");
          // A timer only where the platform would otherwise re-engage into the silence.
          eq(`${label}: heartbeat`, hold.heartbeat, userActivity);
          eq(`${label}: snapshot.wasMuted`, hold.snapshot.wasMuted, wasMuted);
          eq(`${label}: snapshot.atLine`, hold.snapshot.atLine, 2);

          const lines = [agentLine, userLine, ...after];
          const rel = planRelease(hold.snapshot, { lines, at: 4_000 });
          // The learner's own mute is restored, never overridden.
          eq(`${label}: restores mute`, rel.micMuted, wasMuted);
          // At most ONE turn is ever owed. An unbounded resume was the bug the three messages fixed.
          const owed = rel.say;
          const expected = speaking
            ? ABORTED_RESUME_MESSAGE
            : after.some((l) => l.role === "agent")
              ? UNHEARD_RESUME_MESSAGE
              : null;
          eq(`${label}: owes`, owed, expected);
          pauseCases += 1;
        }

// 2. A CUT-OFF TURN OUTRANKS AN UNHEARD ONE. Both conditions can hold at once — we barged in AND a
//    later turn played into the void — and the tail of the thought the learner was mid-way through
//    hearing is the thing they are owed. Pinned because the two branches read as interchangeable.
{
  const hold = planHold(CAPS(), { speaking: true, muted: false, lineCount: 0, at: 0 });
  const rel = planRelease(hold.snapshot, { lines: [agentLine, agentLine], at: 1_000 });
  eq("pause: aborted outranks unheard", rel.say, ABORTED_RESUME_MESSAGE);
}

// 3. THE ORDER THE LEARNER PERCEIVES. Output first, then the microphone — both instant, and between
//    them the whole of what a pause feels like. The barge-in lands before the context update.
{
  const fake = createFakeTransport();
  const hold = planHold(fake.controls.capabilities, {
    speaking: true,
    muted: false,
    lineCount: 0,
    at: 0,
  });
  const silenced = applyHold(fake.controls, hold);
  eq("pause: hold order", fake.sequence(), [
    "setOutputSilenced",
    "setMicMuted",
    "cancelTurn",
    "context",
  ]);
  eq("pause: silenced when the transport can", silenced, true);
  eq("pause: silences rather than unsilences", fake.argOf("setOutputSilenced"), true);
}

// 4. A PROVIDER THAT CANNOT SILENCE MUST SAY SO. This is the whole reason the method returns a
//    boolean: a paused screen that claimed a silence it did not deliver is the false pass
//    `lib/agent-audio.ts` was written against.
{
  const fake = createFakeTransport({ canSilence: false });
  const hold = planHold(fake.controls.capabilities, {
    speaking: false,
    muted: false,
    lineCount: 0,
    at: 0,
  });
  eq("pause: reports a failed silence", applyHold(fake.controls, hold), false);
}

// 5. ON A PROVIDER THAT CAN CANCEL, THE TRANSCRIPT STAYS CLEAN. The fake user message costs a turn
//    and has to be filtered back out by HIDDEN_KICKOFF_MESSAGES; `cancelTurn` costs nothing. This
//    pins the §11.2 improvement so a later refactor cannot quietly hand it back.
{
  const fake = createFakeTransport({ capabilities: { cancelTurn: true } });
  const hold = planHold(fake.controls.capabilities, {
    speaking: true,
    muted: false,
    lineCount: 0,
    at: 0,
  });
  applyHold(fake.controls, hold);
  eq("pause: cancel never speaks", fake.calls.some((c) => c.method === "say"), false);

  const legacy = createFakeTransport({ capabilities: { cancelTurn: false } });
  const legacyHold = planHold(legacy.controls.capabilities, {
    speaking: true,
    muted: false,
    lineCount: 0,
    at: 0,
  });
  applyHold(legacy.controls, legacyHold);
  eq("pause: fallback speaks the filtered message", legacy.argOf("say"), PAUSE_STOP_MESSAGE);
}

// 6. RELEASE ORDER, and the silent case. Nothing owed means nothing said — a resume that spoke
//    anyway would restart a lesson the learner never left.
{
  const fake = createFakeTransport();
  const hold = planHold(fake.controls.capabilities, {
    speaking: false,
    muted: false,
    lineCount: 1,
    at: 0,
  });
  fake.reset();
  applyRelease(fake.controls, planRelease(hold.snapshot, { lines: [agentLine], at: 1_000 }));
  eq("pause: release order (nothing owed)", fake.sequence(), [
    "setMicMuted",
    "setOutputSilenced",
    "context",
  ]);
  eq("pause: release unsilences", fake.argOf("setOutputSilenced"), false);

  fake.reset();
  applyRelease(fake.controls, planRelease(hold.snapshot, { lines: [agentLine, agentLine], at: 1_000 }));
  eq("pause: release order (a turn owed)", fake.sequence(), [
    "setMicMuted",
    "setOutputSilenced",
    "context",
    "say",
  ]);
  eq("pause: owes the unheard turn", fake.argOf("say"), UNHEARD_RESUME_MESSAGE);
}

// 7. THE CONTRACT IS NOT REACT-SHAPED. `tutor-transport-fake.ts` is a plain factory with no hooks
//    and no platform, compiled against the same `TutorTransportControls` the ElevenLabs adapter
//    implements — so this block existing at all is most of the assertion. What is checked here is
//    the one ordering rule a fake could get wrong and a session would then pass tests it should
//    fail: `onIdentified` is awaited BEFORE the transport is told to connect.
{
  const fake = createFakeTransport();
  const seen: string[] = [];
  await fake.controls.start({ lessonId: "L", items: [], version: null }, (descriptor) => {
    seen.push(`identified:${descriptor.version}`);
  });
  eq("transport: start seam ran", seen, ["identified:fake-1.0"]);
  eq("transport: start recorded", fake.sequence(), ["start"]);

  const refusing = createFakeTransport({ startError: new Error("no credential") });
  let threw = false;
  try {
    await refusing.controls.start({ lessonId: "L", items: [], version: null }, () => {
      failures.push("transport: a refused credential must not reach the seam");
    });
  } catch {
    threw = true;
  }
  eq("transport: a refused start throws", threw, true);
}

console.log(`checked held-pause properties (${pauseCases} cases)`);

// ── debug reports (R9) ───────────────────────────────────────────────────────────────────────
// The report is built on a phone, in the middle of the failure it describes, and read by a person
// or a model days later. Three things have to hold or it is worse than nothing: it must not carry a
// credential, it must not drop the error to make room for chatter, and an old build's report must
// still be storable by a server that has never heard of its codes.
// See docs/2026-09-09-mobile-debug-reports-and-feedback.md §4.6, §6, §8.

const dbgEvent = (over: Partial<DebugEvent> = {}): DebugEvent => ({
  seq: 1,
  at: "2026-09-09T10:00:00.000Z",
  since: 0,
  level: "debug",
  code: "session.status",
  message: "status",
  provider: null,
  ...over,
});

const ring = (levels: DebugLevel[]): DebugEvent[] =>
  levels.map((level, i) => dbgEvent({ seq: i + 1, level, code: `c${i}` }));

// 1. THE EVICTION ORDER. A ring flooded by `transport.usage` that dropped the connect failure is a
//    ring that was not worth keeping — which is exactly what a plain `slice(-max)` produces.
eq(
  "trimDebugEvents: an error outlives the debug events around it",
  trimDebugEvents(ring(["debug", "error", "debug", "debug"]), 2).map((e) => e.level),
  ["error", "debug"],
);
eq(
  "trimDebugEvents: info/warn go only once every debug has",
  trimDebugEvents(ring(["info", "error", "warn"]), 1).map((e) => e.level),
  ["error"],
);
eq(
  "trimDebugEvents: all-errors falls back to oldest-first",
  trimDebugEvents(ring(["error", "error", "error"]), 1).map((e) => e.seq),
  [3],
);
// Identity, not a copy: the ring calls this on every emit, and a fresh array each time would make
// the modal's `useSyncExternalStore` re-render on events it already has.
{
  const short = ring(["debug", "info"]);
  if (trimDebugEvents(short, 10) !== short) {
    failures.push("trimDebugEvents: an under-length ring must return the input array identity");
  }
}

// 2. REDACTION, the backstop. Nothing should reach it — `data` is flat scalars and `apiFetch` emits
//    a path, not a header — but the cost of being wrong is a credential inside a stored blob.
eq("redactValue: a secret-shaped key is dropped whatever it holds", redactValue("conversationToken", "abc"), "<redacted>");
eq("redactValue: case-insensitive on the key", redactValue("Authorization", "Bearer x"), "<redacted>");
eq(
  "redactValue: a jwt is recognised by shape, under any key",
  redactValue("route", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
  "<jwt>",
);
eq(
  "redactValue: a LiveKit-shaped url keeps its path and loses its query",
  redactValue("url", "wss://live.example.com/rtc?access_token=abc.def.ghi"),
  "wss://live.example.com/rtc",
);
eq("redactValue: an ordinary path is left alone", redactValue("path", "/api/v2/lessons/session"), "/api/v2/lessons/session");

// 3. THE SANITIZER refuses only what is structurally unusable.
eq("sanitizeDebugReport: not an object", sanitizeDebugReport("nope"), null);
eq("sanitizeDebugReport: an array is not a report", sanitizeDebugReport([]), null);
eq("sanitizeDebugReport: no kind", sanitizeDebugReport({ note: "x" }), null);
eq("sanitizeDebugReport: an unknown kind", sanitizeDebugReport({ kind: "wat" }), null);

{
  const minimal = sanitizeDebugReport({ kind: "manual" });
  if (minimal === null) failures.push("sanitizeDebugReport: a bare `kind` must still produce a report");
  else {
    eq("sanitizeDebugReport: absent fields become null, never undefined", minimal.lessonId, null);
    eq("sanitizeDebugReport: a missing snapshot is an empty one, not a crash", minimal.state.live.status, "disconnected");
    eq("sanitizeDebugReport: no frozen snapshot", minimal.state.atError, null);
    eq("sanitizeDebugReport: events default to empty", minimal.events, []);
  }
}

// 4. AN UNKNOWN CODE SURVIVES. The reports that matter most come from the build nobody updated.
{
  const old = sanitizeDebugReport({
    kind: "error",
    events: [dbgEvent({ code: "transport.quantum_flux", level: "error" })],
  });
  eq("sanitizeDebugReport: an unknown code is preserved, not dropped", old?.events[0]?.code, "transport.quantum_flux");
  eq("codes: and it is still reported as unknown", isKnownDebugCode("transport.quantum_flux"), false);
  eq("codes: a real one is known", isKnownDebugCode(DEBUG_CODES[0]), true);
}

// 5. THE BOUNDS. Each one is a place a phone could otherwise hand the server an unbounded blob.
{
  const fat = sanitizeDebugReport({
    kind: "error",
    note: "n".repeat(MAX_DEBUG_NOTE + 500),
    events: [
      // Spread rather than passed through `dbgEvent`, because `nested` is deliberately a shape the
      // typed `DebugData` forbids — the point is what the SANITIZER does with a body that was never
      // type-checked, which is every body it ever sees.
      {
        ...dbgEvent({ message: "m".repeat(MAX_DEBUG_MESSAGE + 100) }),
        data: {
          ...Object.fromEntries(Array.from({ length: MAX_DEBUG_DATA_KEYS + 8 }, (_, i) => [`k${i}`, i])),
          long: "v".repeat(MAX_DEBUG_DATA_VALUE + 100),
          nested: { dropped: true },
        },
      },
    ],
    transcriptTail: Array.from({ length: MAX_DEBUG_TRANSCRIPT_TAIL + 20 }, () => ({ role: "user", text: "hi" })),
  });
  eq("sanitizeDebugReport: note capped", fat?.note.length, MAX_DEBUG_NOTE);
  eq("sanitizeDebugReport: message capped", fat?.events[0]?.message.length, MAX_DEBUG_MESSAGE);
  eq("sanitizeDebugReport: data keys capped", Object.keys(fat?.events[0]?.data ?? {}).length, MAX_DEBUG_DATA_KEYS);
  eq("sanitizeDebugReport: transcript tail capped", fat?.transcriptTail.length, MAX_DEBUG_TRANSCRIPT_TAIL);
  // A nested object is DROPPED rather than stringified: `[object Object]` in a report is a field
  // that looks answered and is not.
  if (Object.values(fat?.events[0]?.data ?? {}).some((v) => typeof v === "object" && v !== null)) {
    failures.push("sanitizeDebugReport: a nested value survived the flat-scalar rule");
  }
}

{
  const over = sanitizeDebugReport({
    kind: "error",
    events: Array.from({ length: MAX_DEBUG_EVENTS + 250 }, (_, i) =>
      dbgEvent({ seq: i, level: i === 0 ? "error" : "debug" }),
    ),
  });
  eq("sanitizeDebugReport: events trimmed to exactly the cap", over?.events.length, MAX_DEBUG_EVENTS);
  // And the trim used the ring's rule, not a slice — the oldest event here is the only error.
  eq("sanitizeDebugReport: the error survived the trim", over?.events[0]?.level, "error");
}

// 6. THE SIZE CAP, and the order it is spent in: the transcript first (it is redundant — the same
//    lines are already stored under `conversationId`), then events, and the note only truncated.
{
  const huge = sanitizeDebugReport({
    kind: "error",
    note: "x".repeat(1_000_000),
    transcriptTail: [{ role: "user", text: "keep me" }],
    // A full ring of maximally fat events — every message and every `data` value at its cap. This
    // is the largest report the phone's own bounds allow, and it is ~3× over the wire cap: the two
    // limits are deliberately not derived from each other, so this is the case that proves the
    // outer one still bites.
    events: Array.from({ length: MAX_DEBUG_EVENTS }, (_, i) =>
      dbgEvent({
        seq: i,
        message: "m".repeat(MAX_DEBUG_MESSAGE),
        data: Object.fromEntries(
          Array.from({ length: MAX_DEBUG_DATA_KEYS }, (_, k) => [`k${k}`, "v".repeat(MAX_DEBUG_DATA_VALUE)]),
        ),
      }),
    ),
  });
  if (huge === null) failures.push("sanitizeDebugReport: an oversized report must be trimmed, not refused");
  else {
    const size = JSON.stringify(huge).length;
    if (size > MAX_REPORT_BYTES) failures.push(`sanitizeDebugReport: still ${size} over the cap`);
    if (huge.note.length === 0) {
      failures.push("sanitizeDebugReport: the note is the one field a machine cannot produce — never dropped");
    }
    if (huge.events.length === 0) {
      failures.push("sanitizeDebugReport: events are halved to fit, not emptied — the ring is the evidence");
    }
    eq("sanitizeDebugReport: the redundant transcript goes first", huge.transcriptTail, []);
  }
}

// 7. THE ROUND TRIP THE SPOOL DEPENDS ON (S2). A report is sanitized, written to the device as
//    JSON, read back by a possibly newer build, and sanitized again before it is sent. That second
//    pass must be a no-op — if it is not, a report changes shape every time the phone fails to send
//    it, and a queue that has waited a week is not the report that was filed.
{
  const filed = sanitizeDebugReport({
    kind: "error",
    note: "the tutor never said anything",
    lessonId: "3f2a1c9e-0000-4000-8000-000000000000",
    conversationId: "conv_123",
    provider: "elevenlabs",
    agentVersion: "words-3.0",
    errorCode: "transport.error",
    errorMessage: "Server error: Unknown error",
    client: { appVersion: "1.0.0", buildNumber: "42", variant: "preview", platform: "ios", osVersion: "26.1", deviceModel: "iPhone 15 Pro", apiBaseUrl: "https://x.vercel.app", online: false },
    events: [dbgEvent({ level: "error", code: "transport.error", data: { code: 1008 } })],
    transcriptTail: [{ role: "agent", text: "hello" }],
    capturedAt: "2026-09-09T10:00:00.000Z",
  });
  const reread = sanitizeDebugReport(JSON.parse(JSON.stringify(filed)) as unknown);
  eq("sanitizeDebugReport: survives a spool round trip unchanged", reread, filed);
}

// 8. `capturedAt` IS NOT `created_at`, and the sanitizer must not invent one. A spooled report can
//    arrive hours after the failure; the column only tells the truth because this value travels.
{
  const spooled = sanitizeDebugReport({ kind: "error", capturedAt: "2026-09-09T09:00:00.000Z" });
  eq("sanitizeDebugReport: capturedAt travels verbatim", spooled?.capturedAt, "2026-09-09T09:00:00.000Z");
  const undated = sanitizeDebugReport({ kind: "error" });
  // The epoch, not `now()`. A report with no capture time must look obviously wrong rather than
  // quietly claim to have been captured the moment the server happened to parse it.
  eq("sanitizeDebugReport: a missing capturedAt is the epoch, never now()", undated?.capturedAt, new Date(0).toISOString());
}

console.log(`checked debug-report properties (${DEBUG_CODES.length} codes)`);

if (failures.length > 0) {
  console.error(`FAILED: ${failures.length}`);
  console.error(failures.slice(0, 5).join("\n---\n"));
  process.exit(1);
}
console.log("shared core: all properties hold");
