# Remote triggers for the local iOS build: a GitHub self-hosted runner kept in the repo

**Goal.** Run `pnpm ship:preview` (`apps/mobile/package.json`: `build:preview:local` builds the
signed `.ipa` on this Mac, then `distribute` uploads it to Diawi for an install link) without sitting
at the Mac. It should start from a **commit**, a **webhook**, or a **Slack message**.

**Constraints, as given.**

1. The repo **stays public**, and no one outside it may get the Mac to run anything.
2. The build runs `ship:preview` with the **environment this Mac already has**: `apps/mobile/.env`,
   the `eas-cli login` session, Xcode, nvm's Node and pnpm, Homebrew's fastlane and CocoaPods.
3. The runner and its scripts live **inside this repo, in one folder** (`actions-runner/`). They
   must not spread across the Mac.

**Decision.** This Mac becomes a GitHub Actions self-hosted runner. Every trigger starts one workflow,
`.github/workflows/ship-preview.yml`. GitHub is the only thing that ever tells the Mac to build, and
the Mac never accepts an inbound connection.

---

## 1. How it works

```text
 TRIGGERS                      GITHUB                              THIS MAC
 ────────                      ──────                              ────────
 git push to master ───────┐
 (apps/mobile/** changed)  │
 curl POST /dispatches ────┼──► "Ship iOS preview" run is queued
 Slack /ship → relay bot ──┤      concurrency: one at a time,
 "Run workflow" / gh CLI ──┘      newest request waits                  ▲
                                         │                              │ outbound HTTPS
                                         └── job for labels ────────────┘ long-poll
                                             [self-hosted, macOS, ios-builder]
                                                                        │
                    actions-runner/  (LaunchAgent, runs as koval)       ▼
                    ├─ hooks/job-started.sh  ── refuses the job unless it is
                    │                            ship-preview.yml @ master by an allowed actor
                    └─ _work/…/eleven-labs-english-agent   (fresh checkout of the commit)
                         1. pnpm install --frozen-lockfile
                         2. cp <working copy>/apps/mobile/.env → checkout
                         3. cd apps/mobile && pnpm ship:preview
                         4. "Install: https://i.diawi.com/…" → run summary
                         5. rm the copied .env
```

### The runner

`actions/runner` (v2.337.0 at the time of writing) is GitHub's open-source agent. It runs as a
LaunchAgent under the logged-in user and keeps a long-poll HTTPS connection *out* to GitHub, asking
for jobs whose `runs-on` labels match its own. There is no tunnel, no open port and no public URL;
the Mac can sit behind any NAT.

Labels: GitHub adds `self-hosted`, `macOS` and `ARM64`; we add `ios-builder`. Every other workflow
in the repo uses `ubuntu-latest`, so none of them can land here, and `ship-preview.yml` can't land
anywhere else.

### What GitHub provides for free

| Need | Provided by |
| --- | --- |
| Queue, one build at a time | `concurrency: { group: ship-preview, cancel-in-progress: false }` |
| Logs, history, re-run button | the Actions tab |
| Authenticating webhook callers | the GitHub token on the `/dispatches` call |
| Retry while the Mac is offline | the job waits in the queue for up to 24 h |

`cancel-in-progress: false` is deliberate. Cancelling halfway through `xcodebuild` throws away ten
minutes and can leave EAS's throwaway keychain behind. With `false`, the running build always
finishes and GitHub holds **one** pending run. A newer request replaces an older pending one, which
gives "after this build, build the newest commit".

### Environment: the same as a manual run

The job builds a **fresh checkout of the commit** in `actions-runner/_work/…`, not your working copy.
Uncommitted changes are therefore never shipped, and the `.ipa` always matches a commit.

Everything else comes from the Mac, unchanged:

| What | How the job gets it |
| --- | --- |
| `apps/mobile/.env` (`DIAWI_TOKEN`, `IPA_OUT`, `EXPO_PUBLIC_*`, `APP_VARIANT`) | The workflow copies it from the working copy into the checkout. `TUTOR_MOBILE_ENV` in the runner's `.env` holds the path. It is deleted again in an `if: always()` step |
| EAS credentials | The job runs as user `koval`, so it uses the existing `eas-cli login` session in `~/.expo/`. No `EXPO_TOKEN` is needed |
| node, pnpm, xcodebuild, fastlane, pod | The runner's `.path`, a snapshot of your shell `PATH` taken by `runner.sh env` |
| Signing | Unchanged: EAS imports the cert into its own throwaway keychain; the WWDR G3 intermediate is in the login keychain (`Local-build.md` §3) |

No GitHub secrets are used. Tokens stay in the one gitignored file they already live in, and only the
copied file in the checkout is new.

### Folder layout: everything in `actions-runner/`

```text
actions-runner/
  runner.sh              committed   install / start / stop / status / logs / env / uninstall
  hooks/job-started.sh   committed   the public-repo guard (§2)
  README.md, .gitignore  committed
  bin/ externals/ *.sh   ignored     the release tarball (runner + its own Node)
  .runner .credentials*  ignored     registration — treat like an SSH key
  .env .path             ignored     job environment (written by runner.sh env)
  _work/                 ignored     job workspace: a full clone of this repo plus node_modules
  _logs/ _diag/          ignored     service log, runner diagnostics
```

`.gitignore` there is `/*` plus re-includes for the committed files, so `git status` stays clean
whatever the runner writes. The same rule makes uninstall exact: `git clean -ffdX -- actions-runner`
removes everything ignored and nothing committed.

**What lives outside the folder, and why:**

| Path | Why it cannot be in the repo |
| --- | --- |
| `~/Library/LaunchAgents/actions.runner.koval-yurko-eleven-labs-english-agent.mac-builder.plist` | launchd starts agents at login only from that directory. `runner.sh install` writes it; `uninstall` deletes it |
| `~/.expo/`, the pnpm store, the login keychain, Xcode's caches | These already exist and are shared with your manual builds. The runner reuses them and adds nothing new |

The runner's own template sends logs to `~/Library/Logs/`; `runner.sh` writes its own plist that logs
to `actions-runner/_logs/` instead.

The nested clone under `_work/` is invisible to the outer repo's tooling. git ignores it. Prettier
honours `.gitignore`. Metro watches only the workspace packages and the root `node_modules`, not the
repo root (checked with `getDefaultConfig`), so there is no crawl and no duplicate-module risk.
`tsc`, ESLint and graphify are scoped to `apps/`, `packages/` and `supabase/`.

---

## 2. Security: a public repo and a runner on a personal Mac

### The threat

Anyone can fork a public repo and open a pull request. A pull-request run uses the workflow files
**from the PR**, so the author can write a job with `runs-on: [self-hosted, ios-builder]` that runs
any shell command on this Mac, as `koval`. That command could read `apps/mobile/.env`, `~/.expo/`
and `~/.ssh`. This is why GitHub advises against self-hosted runners on public repos. Organisations
can restrict a runner to selected workflows through runner groups; a personal repo can't. So the
protection is built from three layers, and the last one is on the Mac.

### Layer 1: GitHub won't start a fork's workflow without approval

Settings → Actions → General → *Approval for running fork pull request workflows from contributors* →
**Require approval for all external contributors**. A fork PR's jobs then wait for your click. This
layer relies on your judgement: an approved PR runs.

### Layer 2: the workflow offers nothing to a fork

`ship-preview.yml` triggers only on `push` to `master`, `workflow_dispatch` and `repository_dispatch`.
All three need write access to the repo: pushing to master, clicking "Run workflow", or a token that
can dispatch. It has no `pull_request` or `pull_request_target` trigger. Its `GITHUB_TOKEN` is
`contents: read`, and `actions/checkout` is pinned to a commit SHA with `persist-credentials: false`.

### Layer 3: the runner refuses everything else (`hooks/job-started.sh`)

The runner runs `ACTIONS_RUNNER_HOOK_JOB_STARTED` before **any** step of **any** job, and a non-zero
exit fails the job on the spot. The hook allows a job only if **all** of these hold:

| Check | Value required |
| --- | --- |
| `GITHUB_REPOSITORY` | `koval-yurko/eleven-labs-english-agent` |
| `GITHUB_EVENT_NAME` | `push`, `workflow_dispatch` or `repository_dispatch` |
| `GITHUB_REF` | `refs/heads/master` |
| `GITHUB_WORKFLOW_REF` | `…/.github/workflows/ship-preview.yml@refs/heads/master` |
| `GITHUB_ACTOR` and `GITHUB_TRIGGERING_ACTOR` | in the allow-list (`koval-yurko`) |

Any unset variable fails closed. Tested against simulated environments:

```text
push to master by koval-yurko            ALLOW
workflow_dispatch                        ALLOW
fork PR (pull_request, refs/pull/7)      DENY
pull_request_target                      DENY
another workflow file on master          DENY
ship-preview.yml on another branch       DENY
re-run clicked by a non-allow-listed user DENY
nothing set                              DENY
```

**Why an attacker can't edit the hook.** The runner reads the hook path from its own `.env` on the
Mac. That path points into **your working copy**, not into the job's checkout. A PR can change
`hooks/job-started.sh` in its own branch, but the Mac keeps running the copy you last pulled. A
change to the guard takes effect only when you pull it.

So a fork PR that gets past layer 1 (an approval by mistake) still fails before its first step. To
get code onto this Mac, an attacker needs push access to `master` or a token you created. Both
already mean the account is compromised, and the runner is not the weakest point then.

### Housekeeping that keeps the layers honest

- Keep `ACTORS` in the hook to people you would hand a shell on this Mac. Adding a repo collaborator
  doesn't add them there.
- The dispatch token (§3.2) is a fine-grained PAT limited to this one repository. Treat it like a
  deploy key.
- Settings → Actions → General → *Workflow permissions* → **Read repository contents** (the default
  for new repos; worth confirming).
- Optional: Settings → Actions → General → *Actions permissions* → allow only actions created by
  GitHub. `ship-preview.yml` uses only `actions/checkout`.

---

## 3. The triggers

### 3.1 Commit

`push` to `master` touching `apps/mobile/**`, `packages/shared/**`, `pnpm-lock.yaml` or
`pnpm-workspace.yaml`. Docs-only and backend-only pushes don't build. `[skip ci]` in a commit message
skips one push. Commits that other workflows make with `GITHUB_TOKEN` never trigger workflows, so
there is no loop.

### 3.2 Webhook

The webhook targets **GitHub's API**, not the Mac:

```bash
curl -fsS -X POST \
  https://api.github.com/repos/koval-yurko/eleven-labs-english-agent/dispatches \
  -H "Authorization: Bearer $GH_DISPATCH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -d '{"event_type":"ship-preview"}'
# → 204, and a run appears in the Actions tab
```

`GH_DISPATCH_TOKEN` is a fine-grained PAT: *Only select repositories* → this repo, permission
*Contents: Read and write* (what `repository_dispatch` requires). The run's actor is the token's
owner, so the hook's actor check passes only for a token created by an allow-listed account. The one
sender this can't serve is a service that can only POST to a fixed URL without an `Authorization`
header (§6).

### 3.3 Slack (phase 2)

Slack can't hold a GitHub token, so a small relay sits in between: a Slack app in **Socket Mode**. It
opens an outbound WebSocket to Slack, so it needs no Request URL and no tunnel. On `/ship` it checks
the Slack user and channel against an allow-list, acks within Slack's 3 s, and runs
`gh workflow run ship-preview.yml`. About 40 lines of `@slack/bolt`. It would live in
`actions-runner/slack/` with its own LaunchAgent. The result goes back through a Slack incoming
webhook in a final workflow step, so the bot never waits on the build. A company workspace may need
an admin to approve custom apps, so check that first. The Slack desktop app plays no part in this; it
has no hook for "run something when a message arrives".

### 3.4 Manual

Actions tab → *Ship iOS preview* → **Run workflow**, or `gh workflow run ship-preview.yml`, or the
GitHub mobile app.

---

## 4. Setup

Checked against this Mac on 2026-10-03: Apple silicon, macOS 26.6.1, Xcode 26.6, fastlane and
CocoaPods in `/opt/homebrew/bin`, Node 24.19 and pnpm from nvm, jq in `/usr/bin`, **FileVault on**,
`pmset` showing `sleep 1`. `Local-build.md` setup (Xcode, fastlane/CocoaPods, WWDR G3, `eas-cli
login`) is already done here, as shown by the unattended `pnpm build:preview:local` on 2026-10-03.

### Step 1: Keep the Mac awake and reachable after a reboot

```bash
sudo pmset -a sleep 0 disksleep 0 autorestart 1
pmset -g | grep -E ' sleep|disksleep|autorestart'   # → 0, 0, 1
```

The LaunchAgent runs only while `koval` is logged in, and code signing needs that session's unlocked
login keychain. **With FileVault on, macOS disables automatic login, so after any reboot someone has
to log in once** (at the Mac or over Screen Sharing). Until then, jobs wait in the queue. A locked
screen is fine. In Keychain Access → *login* → *Change Settings…*, turn **off** "Lock after … of
inactivity" and "Lock when sleeping".

### Step 2: GitHub settings (§2)

Settings → Actions → General:
- *Fork pull request workflows from contributors* → **Require approval for all external contributors**
- *Workflow permissions* → **Read repository contents**
- (optional) *Actions permissions* → allow actions created by GitHub only

### Step 3: Push `ship-preview.yml` before registering the runner

The hook allows only `ship-preview.yml` **on master**, so it has to be there. Pushing it starts no
build: the push touches `.github/`, which isn't in `paths`.

### Step 4: Install the runner

Settings → Actions → Runners → **New self-hosted runner** → copy only the **token** from the
`./config.sh` line (valid for one hour). `runner.sh` handles the download itself. Then, from a normal
terminal (nvm loaded):

```bash
actions-runner/runner.sh install <TOKEN>
```

What it does, in order (each step stops the script on failure):

1. Checks that `node pnpm xcodebuild fastlane pod git jq` are on PATH and that `apps/mobile/.env` has
   `DIAWI_TOKEN`.
2. Downloads `actions-runner-osx-arm64-2.337.0.tar.gz` and verifies its SHA-256 against the digest
   GitHub publishes for the release asset. It refuses on a mismatch or a missing digest.
3. Runs `config.sh --unattended --name mac-builder --labels ios-builder --work _work`.
4. `runner.sh env`: snapshots PATH into `.path`, and sets `LANG=en_US.UTF-8` (CocoaPods needs UTF-8),
   `ACTIONS_RUNNER_HOOK_JOB_STARTED` and `TUTOR_MOBILE_ENV` in `.env`.
5. Writes the LaunchAgent plist and bootstraps it into `gui/<uid>`.

Then check:

```bash
actions-runner/runner.sh status   # → state = running, pid = …
```

GitHub's Runners page shows `mac-builder` as **Idle**.

Verified on 2026-10-03 in a scratch copy: steps 1–2 download and verify the real asset, a bogus token
fails at step 3 with nothing installed, and the generated plist passes `plutil -lint`.

### Step 5: First run

```bash
gh workflow run ship-preview.yml && gh run watch    # or Actions tab → Run workflow
```

In the job log, *Set up runner* shows the hook's `repository=… event=… ref=… workflow_ref=…
actor=…` lines and **`job-started hook: allowed`**. A green run ends with `Install: https://i.diawi.com/…`
in the run summary.

Verified 2026-10-03 (run 37153096339, `workflow_dispatch`): the hook received all five variables
and allowed the job; `pnpm ship:preview` built the 22.3 MB `.ipa` and printed the Diawi link; the
copied `.env` was removed afterwards.

**If the run sits in *Queued* right after install:** launchd can register a freshly bootstrapped agent
without starting it (`launchctl print` shows `runs = 0`, `pended nondemand spawn = speculative`).
`runner.sh start` now follows `bootstrap` with `launchctl kickstart`; on an older copy, run
`actions-runner/runner.sh start` again.

If the build itself fails, compare with a manual `pnpm ship:preview` in the working copy. A failure
only on the runner points at `.path` (rerun `runner.sh env`, then `runner.sh restart`).

### Step 6: Webhook token, then Slack

Create the fine-grained PAT (§3.2), test it with the `curl`, then build the Slack relay (§3.3).

---

## 5. Day-to-day

| Task | Command |
| --- | --- |
| Is it up? | `actions-runner/runner.sh status` |
| Follow the service log | `actions-runner/runner.sh logs` (`_diag/` holds per-job runner logs) |
| Toolchain changed (nvm default, Xcode, Homebrew) | `actions-runner/runner.sh env && actions-runner/runner.sh restart` |
| Remove completely | `actions-runner/runner.sh uninstall <removal token from the Runners page>` |
| Runner upgrade | automatic: it updates itself when GitHub requires it |

- **A queued run that never starts** usually means the Mac rebooted and nobody has logged in yet
  (FileVault, step 1).
- **The runner and you share one Mac.** A triggered build competes with your own work for CPU. The
  keychains don't collide, since EAS uses a throwaway one per build.
- **Provisioning drift.** `--freeze-credentials` makes a drifted profile fail loudly rather than
  prompt. The fix (`pnpm device:register`, `build:preview:local:refresh`) is interactive and stays a
  hands-on task.
- **Disk.** `_work/` holds one checkout plus `node_modules`, and is reused run to run. EAS cleans its
  temp build dir. Watch Xcode's DerivedData over months.

---

## 6. Not chosen: a tunnel and a webhook receiver

Exposing the Mac (`cloudflared` is already at `/opt/homebrew/bin`) and running a receiver that
builds directly would mean owning three signature schemes (GitHub HMAC, Slack signing secret, a
shared secret), a queue (Slack wants an answer in 3 s; a build takes about 10 min), a log viewer and a
public attack surface. The runner provides all of that with no inbound port.

Keep it only for a sender that can't set an `Authorization` header. Even then, the receiver should
just run `gh workflow run ship-preview.yml`, so the queue, the logs and the hook stay in one path.
