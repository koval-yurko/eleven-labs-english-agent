# Suggestions on the lesson page, and what "Start" means

_2026-08-21._

---

## §1 — Two add paths that look identical and are not

The lesson page had a multiline box — *"Add words or sentences — one per line"* — and a bulk
**Add words** button. The collection page (`/lesson-items`) has a single-line **Add a word** field
with lexicon autocomplete: prefix suggestions, CEFR badge, Russian glosses, and an "already in your
collection" marker. The ask was to put the second on the first, with the word attached to the lesson.

The trap is that the two screens do not share a write path, and the collection's is the wrong one
here:

| | collection | lesson |
|---|---|---|
| call | `addWord` → `POST /api/v2/lesson-items` | `buildAddItemsOp` → `postOp` → `/sync/flush` |
| creates | a `words` row in **no lesson** | a `words` row **and** its `lesson_items` link |
| dedupe | server, by `norm_key` | `planNewItems` client-side, then the server's `linked` guard |

`src/lib/items.ts` says why the asymmetry exists at all: collection writes deliberately skip the
outbox, because `MirrorItem` is keyed on a `lesson_id` a standalone word does not have.

So what moved is **the field, not the write**. `addWordToLesson` still builds an `addItemsOp` and
still posts it through the outbox algebra; only the control that feeds it changed. Lifting the
collection's `AddWordForm` wholesale would have compiled, looked right, and quietly added words to
nothing.

## §2 — Bulk paste is gone

The replaced box took newline-separated input and added up to `room` items at once. It was the only
bulk-entry point in the app, and `AddWordForm`'s own docblock on the collection page points *here*
for it:

> Single-line on purpose: the ask is an *individual* word. A textarea would invite bulk paste, and
> a bulk paste wants a lesson to live in — that flow already exists on the lesson page.

That sentence is now false, and the loss is structural rather than incidental: **a textarea cannot
have an autocomplete**, because there is no single word to complete. Suggestions and bulk paste are
mutually exclusive in one control, so this was a choice between them, and the ask picked
suggestions.

If bulk paste is missed, the honest shape is a second, disclosed control ("add several at once")
rather than putting the textarea back — not a compromise that makes the suggestion field worse.

## §3 — What the field marks

`markedLabel` is **"Already in this lesson"**, not the collection's "Already in your collection".
The API returns `owned`, which is the collection-level fact; on this screen it is the wrong warning,
because a word the learner owns but has not put in *this* lesson is precisely what they came to add.

The marker is computed with `clientDedupeKey` — the same key `planNewItems` uses to decide whether
the add is a duplicate — so the marker on a row and the behaviour of the button cannot disagree. It
is weaker than the Postgres identity by design, and in the safe direction: it may fail to mark a
word the server would merge, never the reverse. An unmarked duplicate is caught by
`buildAddItemsOp` returning `null`, which is now **said** ("already in this lesson") rather than
swallowed. With a bulk textarea a silently-skipped duplicate was one line among several; adding one
word at a time, silence reads as a dead button.

Three other details carried across from the collection's form:

- **`zIndex: 10` on the containing panel.** The popup is an absolute overlay hanging past the
  panel's bottom edge, and `zIndex` only orders siblings — so the panel has to outrank the Practice
  panel below it. Setting it on the popup alone does nothing across that boundary.
- **`clearSuggestionCache()` after a successful add.** The bucket cache carries a per-learner
  `owned` flag, and a word added to a lesson is a `words` row the learner now owns.
- **`writeItems` now returns whether the write landed**, so the field only says "Added" when
  something was. A failed write already shows itself through `itemsError` and its Retry, and the
  optimistic row has been rolled back — "Added" on top of that would be the screen contradicting
  itself.

---

## §4 — Start and Resume were the same call

Raised while the above was being built, and it was a real defect I had introduced.

On a parked pause the button row shows **Start conversation** and **Resume**. Both ran `start()` —
and `start()` resumes whenever `resumeContextRef` holds anything. So the button labelled "Start
conversation" silently continued the previous conversation. That was survivable only while the
removed pause panel still offered **"Start fresh instead"**; once that went (2026-08-21 §2), there
was no way to get a clean conversation at all.

The fix is that the two controls now differ, which they always claimed to:

- **Start conversation** → `discardParkedSession()` first. Fresh, always.
- **Resume** → carries the tail. The one control that does.

**End is a full stop.** `endWithPersist` clears the parked context and the on-disk pause marker, so
the next Start begins a new lesson. `onDisconnect` already declined to park a context for
`reason: "user"` without a pause intent — but "already, mostly" was the problem: the parked copy
*also* lives on disk, where it outlives the process and is read back at the next mount, and nothing
cleared that on End. The guarantee is now a statement in one place rather than an emergent property
of three cooperating branches.

The model this settles on, which is the one the buttons imply: **Pause/Resume continues a
conversation; Start/End bounds one.**

---

## §5 — Verified

`tsc --noEmit`, `eslint .`, `check:logic`, `expo export` — all clean on `apps/mobile`. No server or
shared-core change: the write path, the ops and the routes are untouched.

Not verified without a device: the popup overlay on this screen specifically. `Autocomplete`'s
docblock warns it is "iOS-correct and Android-approximate" because Android clips children escaping a
parent's bounds, and this is its second caller — the first sits in a panel with different
neighbours.
