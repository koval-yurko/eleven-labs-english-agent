# The device remembers which tutor you picked

**2026-09-26.** Built. Closes debug report `9158f95b`, filed from the phone on 2026-09-24 as
`kind: feedback`:

> want to keep my selection about prompt/agent version I selected
> in localStorage for example
> so I do not need to have the same selection for each lesson

---

## §1 The bug behind the request

The tutor picker on `/lessons/[id]` was never persisted anywhere. Its value came from

```ts
const selectedVersion = (isOurs ? session.version : null) ?? versions?.defaultVersion ?? null;
```

and `session.version` is cleared by `focusLesson` on every move between lessons
(`tutor-session.tsx`, `setVersion(null)`). So the picker fell back to `defaultVersion` — the
registry's answer, from `/api/v2/agent-versions` — the moment you opened a different lesson, and
again on every app launch.

That is correct behaviour for `version`: it is *what this lesson is running or was set to*, and a
value that survived a move would be describing the wrong conversation. What was missing is a second,
weaker thing: **what this learner tends to want**, which is not session state at all.

## §2 One remembered value, not one per lesson

Settled with the product owner before building. The alternative — a version remembered per lesson —
was rejected on two counts:

- **It does not answer the complaint.** A lesson that has never been started has nothing stored and
  still opens on the default, and new lessons are exactly where the re-picking happens.
- **It makes the picker unreadable.** Its value would depend on invisible per-lesson history, so
  "why is this one on 2.0" stops having an answer anyone can give without a database.

So: one value on the device, the last version chosen anywhere. The learner's own framing —
"in localStorage" — is a single global slot, and that is the right shape.

## §3 What was built

| File | Role |
|---|---|
| `apps/mobile/src/lib/tutor-preference.ts` | Storage. `readPreferredVersion` / `writePreferredVersion` over `expo-sqlite/kv-store`, key `pref:tutor-version` |
| `apps/mobile/src/lib/tutor-version.ts` | `resolveTutorVersion` — the precedence rule, pure, no native imports |
| `apps/mobile/src/lib/tutor-session.tsx` | Reads the preference once at mount into `preferredVersion`; `chooseVersion` writes it |
| `apps/mobile/src/app/lessons/[id]/index.tsx` | Resolves the picker's value; emits `pref.version_dropped` |
| `packages/shared/src/debug/{report,codes}.ts` | `preferredVersion` on `SessionSnapshot`; two new codes |
| `apps/mobile/check.ts` | Twelve cases over the precedence rule |

### 3.1 The precedence

1. **The live session**, when it is this lesson's. What is actually running outranks a preference —
   the picker is disabled while connected precisely because it is then a readout, not a control.
2. **The stored preference**, *if the registry still offers it*. The new step.
3. **The server's default**, which is a server-side rule (`resolveVersion(null)`) the client is
   deliberately not allowed to re-derive — see the `agent-versions` route's docblock.

A fourth case matters as much as the three: **before `/api/v2/agent-versions` answers, the
preference is held back and the picker shows nothing.** Showing it and correcting it a moment later
is worse than showing nothing — it looks like the app changed its mind unprompted, on the one
control whose entire job is to be remembered.

### 3.2 It stores the version, never the provider

Picking a version *is* picking a provider (§13 Q1/Q2 of
`docs/2026-08-22-openai-realtime-second-provider.md`), and the mapping lives on the server. Storing
the provider beside it would freeze today's mapping onto the device: a version moved to another
service by `pnpm sync:agents` would then run on the stack the phone remembered, not the one the
registry names.

### 3.3 The preference is a hint, and it is allowed to lose

A stored version can name a prompt that no longer exists — a retired version, a build that sat on a
phone across two deploys. The offered list is the authority, so the preference applies only when it
is in that list. That check is why nothing on the device needs migrating when a version is retired,
and why a stale value can never be sent to a token route that cannot honour it.

### 3.4 Only a tap is a preference

`version` is also set by `start`, from the descriptor the **server** resolved. That write does not
persist. If it did, a server-side fallback — a version retired between the pick and the connect —
would silently become the learner's remembered choice, and the app would have taught itself a
preference nobody expressed.

## §4 Making the new invisible state observable

The preference is device state the learner cannot see, and its wrong value looks like *the app chose
a tutor I didn't pick*. That is precisely the failure class §5.1 of
`docs/2026-09-09-mobile-debug-reports-and-feedback.md` argues must reach a report, so:

- **`SessionSnapshot.preferredVersion`** — `version` says what ran, this says what the phone would
  have offered. They differ exactly when something is wrong.
- **`pref.version_dropped`** — emitted once per stale value, when a remembered version is no longer
  offered and the default was used instead. Without it, a learner who finds a different tutor
  selected has no way to know a preference was overruled rather than lost, and neither has anyone
  reading the report they file about it.
- **`pref.write_failed`** — the choice did not reach disk, so it will not stick. The symptom, "it
  keeps forgetting", is the exact complaint this work was for.

There is deliberately **no `pref.version_restored`**: it would fire on every launch and say only
that the feature works. `session.start` already carries the version a lesson actually ran on.

A failed *read* is silent, unlike a failed write — it is indistinguishable from "nothing stored
yet", which is every first launch, and a line in every new install's first report that means nothing
is worse than no line.

## §5 Checked

`resolveTutorVersion` is pure and lives apart from the storage for one reason: `apps/mobile/check.ts`
runs under plain `tsx` and cannot import anything that reaches `expo-sqlite`. A precedence rule that
cannot be checked is the worst kind of bug here — resolving wrongly is indistinguishable from the
picker having forgotten, and neither is visible until a learner notices weeks later that they have
been talking to the wrong tutor.

`pnpm --filter mobile check:logic` covers the three precedence steps, the held-back window, the
stale-preference fallback and its `stale` report, and the empty-registry case.

## §6 Not built

- **A settings screen.** The picker is already on the lesson screen and is now sticky; a second
  place to set the same thing is a second thing that can disagree with it.
- **A "remembered" badge on the picker.** It would be on screen permanently after the first choice
  and would say nothing the value does not. The one moment worth narrating — a preference
  overruled — is narrated into the report instead, where someone can act on it.
- **Clearing the preference from the UI.** Picking any version overwrites it, which is the same
  gesture; a Reset button exists to restore a default the picker can already select.
- **Per-owner keys.** Single-learner app, and the journal keys are device-wide for the same reason.
  The day a second account signs in on one phone, this and `journal:` move together.
