# Unattended local iOS builds and a predictable artifact

`pnpm build:preview:local` could not be automated. It stopped twice to ask questions, and it named
its output after the clock, so no later step could find the file it had just produced. This note
records what changed, why each piece is shaped the way it is, and — the part that matters six months
from now — *why it works*, with the mechanism rather than the incantation.

Scope: `apps/mobile` only. Nothing here touches the cloud build (`pnpm build:preview`), which was
already unattended because EAS runs it on its own machine.

Companion: `apps/mobile/Local-build.md` is the operator's page — setup, running it, troubleshooting.
This is the decision record behind it.

Downstream: `docs/2026-10-03-remote-triggers-for-local-ios-build.md` is what this unblocks — a
self-hosted runner on this Mac invoking `pnpm --filter mobile ship:preview` with `EXPO_TOKEN` and
`DIAWI_TOKEN` from secrets. That workflow is the reason the build had to stop asking questions: a
runner has no one to answer them. It already assumes the names and the CI posture settled here.

---

## §0 What changed, in one page

| # | Change | Where | Why it has to be there |
|---|--------|-------|------------------------|
| 1 | `--non-interactive` on the local build | `apps/mobile/package.json` | The two prompts came from EAS's credentials-setup flow. Non-interactive takes a branch that validates the stored credentials and returns them, never reaching the code that logs into Apple or picks devices |
| 2 | `--freeze-credentials` alongside it | same | A guard, not the fix: forbids EAS mutating stored credentials, and turns the `--refresh…` conflict into an explicit error |
| 3 | `--output <path>` | same | Replaces `build-<timestamp>.ipa` with a path chosen in advance, so the next step can be written before the build runs |
| 4 | `IPA_OUT`, read by the build *and* the upload | `package.json` + `scripts/distribute.mjs` | One name for one path. Two defaults would be two things to keep in step, and they would drift silently |
| 5 | The mtime scan deleted | `scripts/distribute.mjs` | "Newest `.ipa` in the directory" is a guess. With an agreed path there is nothing to guess, and a stale artifact can no longer be uploaded as if it were fresh |
| 6 | `diawi` → `distribute`, `ship:diawi` → `ship:preview` | both `package.json`s, script file | The command is the interface and outlives the vendor. The vendor is now confined to one labelled block |
| 7 | The install link posted to Slack | `scripts/distribute.mjs` | A URL printed in a terminal has to be retyped to reach a phone. A webhook post with a tappable button is the shortest path from "built" to "installed" — and it works on a local run, not just in CI |
| 8 | `build:preview:local:refresh` | `apps/mobile/package.json` | The one case non-interactive genuinely cannot serve — a newly registered device — gets its own interactive script instead of degrading the common path |

Pinned to `eas-cli/24.10.0`. The line numbers in §2 are from that version; they are evidence for the
claims, not an API to depend on.

---

## §1 The failure this exists for

`ship:preview` is `build:preview:local && distribute`. A chain like that needs two properties the
build did not have: it must not ask questions, and it must put its output somewhere the next link
already knows about. It had neither.

### 1.1 Two questions, asked every run

```text
✔ Do you want to log in to your Apple account? … yes
✔ All your registered devices are present in the Provisioning Profile. Would you like to reuse the profile? › Yes
```

Both are answered the same way every time, which is the tell: they are not decisions, they are
ceremony. The second one is the more revealing of the two — it asks whether to reuse a profile that
it has *just finished confirming* is complete. Nothing in the log between them is a change; the whole
sequence is EAS offering to validate against Apple credentials it already holds and has already
validated.

### 1.2 A filename only the clock knows

The artifact landed as `apps/mobile/build-1790944479213.ipa`. That number is `Date.now()` at the
moment the artifact was copied, so the name cannot be computed in advance, cannot be written into a
later command, and cannot be distinguished from the previous run's file except by comparing
timestamps. `scripts/distribute.mjs` did exactly that — it listed the directory, filtered `.ipa`,
sorted by `mtime` and took the first. That works right up until it doesn't: a failed build leaves
the previous success as the newest file, and the upload then ships a stale binary wearing the
current commit's label.

So the two problems are one problem. The build's output was undescribed, and everything downstream
had to compensate with either a human or a heuristic.

---

## §2 Why `--non-interactive` removes both prompts

This is the part worth understanding, because the obvious reading — "it suppresses prompts, so it
must be answering them with defaults" — is wrong, and would be alarming if it were right. Nobody
should want a pipeline silently accepting whatever EAS proposes about signing.

What actually happens is that non-interactive mode takes a **different and shorter path**. In
`eas-cli/build/credentials/ios/actions/SetUpAdhocProvisioningProfile.js` (the action for this
profile, since `preview` is `"distribution": "internal"`, i.e. ad hoc):

```js
const areBuildCredentialsSetup = await this.areBuildCredentialsSetupAsync(ctx);  // :48
if (ctx.nonInteractive) {                                                        // :49
  if (areBuildCredentialsSetup) {
    return nullthrows(await getBuildCredentialsAsync(ctx, app, IosDistributionType.AdHoc));
  } else {
    throw new MissingCredentialsNonInteractiveError(                             // :54
      'Provisioning profile is not configured correctly. Run this command again in interactive mode.');
  }
}
```

Three things follow, and together they are the whole justification:

1. **It returns before the Apple path exists.** Everything that authenticates with Apple
   (`ctx.appStore.ensureAuthenticatedAsync()`) and everything that selects devices
   (`chooseDevicesAsync`) lives in `runWithDistributionCertificateAsync`, which this `return` skips
   entirely. The Apple login prompt is not suppressed — the code that would need it is never
   reached. That is also why the build no longer touches the Apple Developer Portal at all.

2. **The reuse question is structurally absent.** The `All your registered devices are present…`
   text is at `:215`, inside `shouldUseExistingProfileAsync`, which is only called in the interactive
   branch below the early return. There is no default being applied; the question has no code path.

3. **It is not trust, it is validation.** `areBuildCredentialsSetupAsync` (`:167`) calls
   `validateProvisioningProfileAsync` — the profile is checked against the target and the
   distribution certificate before being reused. If that check fails, the `else` at `:54` **throws**.
   This is the property that makes the flag safe in a pipeline: the failure mode of drifted
   credentials is a non-zero exit with a message naming the fix, not a silently wrong binary.

`SetUpDistributionCertificate.js` behaves the same way (`:27`, `:46`): in non-interactive mode it
raises `MissingCredentialsNonInteractiveError` rather than creating a certificate. Worth stating
plainly, because an auto-created distribution certificate would be a genuinely bad outcome — Apple
allows an account only two, and burning one invalidates existing profiles (see
`Local-build.md` §3, which is emphatic about not regenerating it).

### 2.1 What `--freeze-credentials` is actually for

Having read the above: on this path, it changes nothing. The non-interactive branch returns stored
credentials and mutates nothing, so there is nothing left to freeze.

It is kept for two narrower reasons, and the doc should be honest that neither is "it stops the
prompts":

- It guards the paths this profile does not take today — `SetUpProvisioningProfile`,
  `CreateProvisioningProfile`, `ConfigureProvisioningProfile` all consult `ctx.freezeCredentials`
  and are what a `store` or enterprise distribution would reach. If `preview` is ever re-pointed,
  the guard is already in place.
- It makes one specific mistake loud. Combined with `--refresh-ad-hoc-provisioning-profile` it is a
  hard error at `:40`:

  ```text
  Cannot refresh ad-hoc provisioning profile when credentials are frozen.
  Remove --freeze-credentials or --refresh-ad-hoc-provisioning-profile.
  ```

  That is the reason `build:preview:local:refresh` (§7) carries neither `--freeze-credentials` nor
  `--non-interactive`: the two flags are mutually exclusive by construction, and the refresh script
  would fail instantly if it inherited them.

---

## §3 The artifact path contract

`--output` is not a post-build rename, which matters for reasoning about failure: there is no window
in which the file exists under one name and then moves. The flag threads through as a single
destination, decided before the build starts:

| Step | Code | Effect |
|---|---|---|
| 1 | `build/commands/build/index.js:188` | `artifactPath: path.resolve(process.cwd(), flags.output)` — **resolved against the CWD**, so a relative path in an npm script resolves under `apps/mobile`, where pnpm runs it |
| 2 | `build/commands/build/index.js:153` | `--output` without `--local` is rejected outright; it is a local-build concept only |
| 3 | `build/build/local.js:63` | passed to the build plugin as `EAS_LOCAL_BUILD_ARTIFACT_PATH` |
| 4 | `eas-cli-local-build-plugin/dist/config.js:15` | read back as `config.artifactPath` |
| 5 | `…/dist/artifacts.js:66` | `const destPath = config.artifactPath ?? path.join(config.artifactsDir, artifactName)` — our path *replaces* `build-${Date.now()}`; it is not written alongside it |
| 6 | `…/dist/artifacts.js:67` | `fs-extra.copy(localPath, destPath)` — **creates missing parent directories**, so `artifacts/` needs no `mkdir` |

Step 5 is the one that answers "will I still get a stray timestamped file?" — no, because
`artifactName` is only consulted when `artifactPath` is absent. Step 6 is why the default path can
name a directory that does not exist yet on a fresh checkout.

Two facts in that table were verified rather than assumed, because a permanent doc should not record
a guess: the parent-directory creation was checked directly against the `fs-extra` the plugin
resolves, and step 5 was confirmed by a full build producing exactly one `.ipa`, at the given path
(§8).

A sibling lever exists and was *not* used: `EAS_LOCAL_BUILD_ARTIFACTS_DIR` (`config.js:14`) sets the
directory but keeps the `build-<timestamp>` name. That solves location and leaves the real problem —
the unpredictable name — untouched.

---

## §4 One name, two readers

The build writes the file; the upload reads it. Two steps, one path, and therefore exactly one place
the path may be written down. `IPA_OUT` is that place:

```jsonc
// apps/mobile/package.json
"build:preview:local": "… --output ${IPA_OUT:-artifacts/english-tutor-preview.ipa}"
```

```js
// apps/mobile/scripts/distribute.mjs
// Kept in step with --output in package.json's build:preview:local; IPA_OUT overrides both.
const DEFAULT_IPA = process.env.IPA_OUT ?? "artifacts/english-tutor-preview.ipa";
```

The default is spelled twice, which is a cost worth naming: a literal in a JSON string cannot be
shared with a JS module without adding a config file or a wrapper script to read it. The judgement
was that one duplicated literal, with a comment on each side pointing at the other, is cheaper than
a new indirection layer for a two-line pipeline. The override — the part that varies, and the part a
pipeline actually touches — is genuinely single-sourced, so the two literals can only disagree if
someone edits one and not the other, and `${IPA_OUT:-…}` means nobody has a reason to.

`${IPA_OUT:-default}` is POSIX parameter expansion, and pnpm runs scripts through a shell, so it
expands as written. This was checked both ways (unset → default, set → override) rather than
assumed, because a silently unexpanded `${IPA_OUT:-…}` would become a *literal directory name* and
the failure would look like a path bug.

Both readers resolve a relative value the same way — eas against the CWD, `distribute.mjs` against
`MOBILE_DIR` — which coincide under pnpm. An explicit positional argument to `distribute` still
resolves against the CWD, deliberately: that is what a path typed at a prompt means.

```bash
IPA_OUT=artifacts/preview-$(git rev-parse --short HEAD).ipa pnpm ship:preview
```

---

## §5 Why the upload no longer guesses

`newestIpa()` is gone. It was a reasonable shim for an undescribed output and became dead weight the
moment the output got a name — but the argument for deleting rather than demoting it is worth
keeping, because "leave it as a fallback" was the tempting option.

A fallback would mean: when the expected file is missing, upload a different one. Those are not
interchangeable. The expected file missing means *the build did not produce it*, and the only honest
response is to say so:

```text
distribute: …/artifacts/english-tutor-preview.ipa not found — run pnpm build:preview:local first
```

The failure a fallback would have produced instead is the expensive kind: a successful-looking
upload, a valid install link, and a build from an hour ago behind it. Nothing downstream could detect
that. A missing file is a loud, cheap, correctly-attributed failure, and `ship:preview`'s `&&`
already guarantees the build succeeded before the upload is reached.

The orphan `build-1790944479213.ipa` in the working tree is from the old scheme and is now inert —
nothing looks for it. It is gitignored, so it is litter rather than risk.

---

## §6 A provider-neutral command with a confined provider

`pnpm diawi` named a vendor in the one place that is hardest to change: every caller. Renaming to
`pnpm distribute` ("distribute" being the standard term for getting a signed build onto a provisioned
device) means `ship:preview`, the docs and any future CI step describe *what happens*, and a change
of provider does not reach them.

The vendor deliberately stays named inside the implementation:

```js
// ── Provider: Diawi ──────────────────────────────────────────────────────────
// Swapping provider means this block, DIAWI_TOKEN in readToken() and the two request bodies.
```

`DIAWI_TOKEN` keeps its name on purpose, and the reasoning generalises: a credential should be named
after the thing it authenticates to. A generic `UPLOAD_TOKEN` would be harder to trace to the
dashboard that issued it, impossible to hold alongside a second provider during a migration, and
would gain nothing — the point of the rename was to clean up the *interface*, not to pretend the
implementation has no vendor. The split is: generic command, labelled provider, three named places
to touch.

### 6.1 One indirection tried and backed out

The token name was briefly lifted into a `TOKEN_ENV_VAR` constant, so `readToken()` would not mention
Diawi. `pnpm lint` rejected it:

```text
error  Unexpected dynamic access. Cannot dynamically access TOKEN_ENV_VAR from process.env
       expo/no-dynamic-env-var
```

The rule exists because Expo's bundler statically replaces `process.env.X`, so a computed key cannot
be substituted. It does not strictly apply to a Node CLI script that the bundler never sees — but
the constant was bought nothing anyway (the name is one grep away, and a single call site does not
benefit from indirection), so the right move was to drop the indirection rather than to carve out an
exception. Recorded here so the idea is not re-attempted.

### 6.2 The install link in Slack

The link's job is to be opened on a phone, and a URL in terminal scrollback is in the wrong place
for that. So `distribute.mjs` also posts it to a Slack incoming webhook when `SLACK_WEBHOOK_URL` is
set — as a Block Kit link button, which needs no interactivity endpoint and is one tap on a phone.
The top-level `text` repeats the link, because that is what a push notification renders, and the
notification is often the fastest route of all.

Three decisions inside that:

- **In the script, not in the workflow.** The CI plan
  (`docs/2026-10-03-remote-triggers-for-local-ios-build.md`, step 7) had the workflow recover the
  link from stdout with `link=$(sed -n 's/^Install: //p' distribute.log)` and post it from a later
  step. Putting the post where the link is already a variable removes that parsing — `--comment`
  text or the `QR code:` line can both contain a URL — and, more importantly, makes it work on a
  plain local `pnpm ship:preview`, which is the case the terminal link was failing. The `Install: `
  line is still printed, so the workflow's `sed` keeps working if it is ever wanted.
- **It cannot fail the ship.** By the time it runs, the `.ipa` is uploaded and the link is on
  stdout: the ship has succeeded. A stale webhook or a Slack outage therefore warns and leaves the
  exit code at 0, because a non-zero exit would report a successful build as a failed one. A CI job
  that must know about Slack failures should watch for the warning, not the exit code.
- **The password is not posted.** `--password` protects the install page; echoing the value beside
  the link in a channel would undo that. The message shows a `:lock: password required` marker
  instead, and the value stays in the terminal of whoever chose it.

`SLACK_WEBHOOK_URL` is registered `#`-commented in `.env.example`, which is the push allowlist:
`scripts/env-sync.mjs:491` skips commented keys, so the webhook is never pushed to EAS. Opting out
for a single run is `--no-slack`.

---

## §7 The one case that still needs a human

Registering a handset (`pnpm device:register`) leaves the ad hoc profile without that UDID.
Regenerating it is a real change to real Apple state and genuinely requires Apple Developer login —
precisely the work §2 showed non-interactive mode declines to do. By design, `build:preview:local`
**fails** in that situation rather than quietly reshaping credentials.

That case gets its own script instead of weakening the common one:

```jsonc
"build:preview:local:refresh": "npx eas-cli build --platform ios --profile preview --local --refresh-ad-hoc-provisioning-profile --output ${IPA_OUT:-…}"
```

Neither `--non-interactive` nor `--freeze-credentials`: the first would defeat the purpose, and the
second is a hard error in combination (§2.1). Run once per new device; the ordinary script is correct
again afterwards. Keeping the two paths as two scripts is the point — the frequent path is safe and
silent, the rare path is interactive and explicit, and neither has to compromise for the other.

---

## §8 What was verified, and what was not

Verified by a full run on this Mac, 2026-10-03, `eas-cli/24.10.0`:

| Claim | Evidence |
|---|---|
| No prompt of any kind | A complete `--non-interactive --freeze-credentials` build from clean, **exit 0**, with no input supplied. The log goes straight from `All credentials are ready to build` to `Computed project fingerprint` to `PREPARE_PROJECT` — the Apple login and reuse questions do not appear |
| No Apple Developer round-trip | None of the previous run's `Logged in`, `Bundle identifier registered`, `Synced capabilities`, `Fetched Apple provisioning profiles` lines are present |
| Credentials still validated, not bypassed | `PREPARE_CREDENTIALS` imports the certificate and logs `Verifying whether the distribution certificate and provisioning profile match` for both targets (`EnglishTutorPreview`, `controls`) |
| `--output` honoured exactly | `[PREPARE_ARTIFACTS] Writing artifacts to …/test.ipa`, and a 22.3 MB `.ipa` at that path |
| No stray timestamped file | No new `build-<timestamp>.ipa`; the one in the tree still carries the *previous* run's timestamp |
| Parent directories created | `fs-extra.copy` into a three-deep missing path, against the plugin's own resolved `fs-extra` |
| `${IPA_OUT:-…}` expands under pnpm | Checked unset (default) and set (override) |
| `distribute` works under the new name | `--help`, the missing-token error and the missing-artifact error all correct; `pnpm lint` and `pnpm typecheck` clean |
| Slack payload is well-formed | Posted against a local mock webhook — correct button `url`, and a fallback `text` carrying the link |
| A Slack failure does not fail the ship | Mock returning `HTTP 403 invalid_token`: warns, **exit 0** |
| `--no-slack` and an unset webhook both post nothing | Mock received no request in either case; exit 0 |
| `--password` does not leak | The value appears nowhere in the captured payload; only `:lock: password required` |

**Not verified, and the honest caveats:**

- **`build:preview:local:refresh` has never been run.** Exercising it needs a genuinely unregistered
  device, and it mutates the shared ad hoc profile, so it was not run speculatively. Its two flags
  are justified from source (`:40`), not from a passing run.
- **The upload leg was not exercised end to end.** `pnpm distribute` publishes a 22 MB build to a
  third party and mints a public install link — an outward-facing act, left for a human to trigger.
  The rename does not touch the request-building code, and every path up to the network call was
  verified.
- **A `node` version mismatch persists.** `--local` ignores the `node: "22.13.1"` pin in `eas.json`
  and uses whatever is on `PATH` (v24.19.0 here). Pre-existing, unrelated to these changes, and the
  reason `Local-build.md` still recommends the cloud build for anything shared widely.
- **`expo doctor` exits non-zero mid-build** (2 of 20 checks) without stopping anything. A pipeline
  must read the build's exit code, not that line.

---

## §9 Alternatives considered

| Option | Why not |
|---|---|
| `credentialsSource: "local"` + the existing `apps/mobile/credentials.json` | Would bypass EAS credential serving entirely, but adds a second source of truth for credentials EAS already holds *and validates* (§2, item 3). The file in the tree is also in the single-target shape while this scheme signs two targets, and it carries a plaintext `.p12` password — a thing to keep out of the automated path, not to put on it |
| Keep the prompts, drive them with `expect` | Scripting answers to questions about signing is the failure mode, not the fix: it would answer "yes, log in and reshape the profile" unattended. The flags make the same situation an error |
| `EAS_LOCAL_BUILD_ARTIFACTS_DIR` instead of `--output` | Sets the directory but keeps `build-<timestamp>`; leaves the unpredictable name, which was the actual problem |
| A wrapper script around `eas build` to rename the artifact afterwards | More moving parts than a flag that already exists, and introduces a window where the file is under the wrong name. `--output` decides the destination before the build starts |
| Keep `newestIpa()` as a fallback | Converts a loud missing-file error into a silent stale-upload (§5) |
| Posting to Slack from the CI workflow instead of the script | Needs the link parsed back out of stdout, and gives nothing to a local run — the case that prompted this (§6.2) |
| A Slack bot token (`chat.postMessage`) instead of an incoming webhook | Scopes, a channel id and an install flow, to post one message to one channel. The webhook is one secret and works identically on this Mac and on the runner |
| Failing the command when Slack rejects the post | Would report a successful, already-uploaded build as a failure (§6.2) |
| `TOKEN_ENV_VAR` indirection | Dead indirection, and it trips `expo/no-dynamic-env-var` (§6.1) |
| Generic `UPLOAD_TOKEN` env var | A credential should name what it authenticates to; blocks holding two providers' tokens during a migration (§6) |

---

## §10 Operating it

```bash
cd apps/mobile
pnpm build:preview:local          # unattended → artifacts/english-tutor-preview.ipa
pnpm distribute                   # upload that file, print an install link
pnpm ship:preview                 # both, in order
pnpm build:preview:local:refresh  # interactive; once, after pnpm device:register
```

`SLACK_WEBHOOK_URL` adds the Slack post; `--no-slack` skips it for one run.
`IPA_OUT` overrides the path for both legs. For CI, export an `EXPO_TOKEN`
(https://expo.dev/settings/access-tokens) instead of relying on an interactive `eas-cli login`
session — a logged-in session is what makes the local build unattended, and a token is the
non-interactive equivalent. `DIAWI_TOKEN` is read from the shell or `apps/mobile/.env`, and is
registered commented-out in `.env.example` so `env-sync` never pushes it to EAS.

Gitignored: `artifacts/`, `*.ipa`.

---

## §11 Loose ends this work surfaced

Neither is caused by these changes; both were noticed while making them and are recorded so they are
not re-discovered.

- **`apps/mobile/credentials.json` holds a plaintext `.p12` password** — but it is correctly
  ignored, and so is `credentials/` beside it. The ignore lives in the **root** `.gitignore`
  (lines 47-48), not in `apps/mobile/.gitignore`, which is the trap: checking the nearer file
  suggests the secret is exposed when it is not. Verified with
  `git check-ignore -v apps/mobile/credentials.json`, which names the rule that covers it. The
  standing note is only that the file is *unused* — the build takes credentials from EAS (§9) — so
  it is a stale copy of signing material rather than a leak.
- **`apps/mobile/build-1790944479213.ipa`** (22 MB) is orphaned by the naming change — nothing reads
  it any more.

---

Related: `apps/mobile/Local-build.md` (the operator's page for all of this),
`docs/2026-10-03-remote-triggers-for-local-ios-build.md` (the CI consumer of these scripts),
`docs/2026-08-13-expo-s7-ship.md` (build identity and internal distribution),
`docs/2026-08-12-expo-build-plan.md` (where local builds sit in the stage plan),
`docs/2026-08-28-env-variable-sync.md` (why `DIAWI_TOKEN` is registered commented-out).
