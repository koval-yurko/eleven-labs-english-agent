# Local iOS builds — the `preview` profile on your own Mac

`pnpm build:preview` runs on EAS servers. The same build runs on this Mac with one extra flag:

```bash
cd apps/mobile
pnpm build:preview:local        # runs unattended; writes artifacts/english-tutor-preview.ipa
```

Verified 2026-08-16: **~10 minutes cold, 22 MB signed `.ipa`.**

The flag only moves the toolchain requirement onto your machine. It does **not** make the build
offline — EAS still serves the signing credentials, the remote build number and the `preview`
environment variables, so `npx eas-cli login` is required.

---

## Setup

Four things, in this order. Everything else the repo already has.

### 1. Xcode — full install, and made active

Command Line Tools are not enough; fastlane's `gym` calls `xcodebuild` from a full Xcode. Installing
Xcode does not select it — this Mac had Xcode 26.6 in `/Applications` while `xcode-select` still
pointed at the CLT, which is the state that makes `xcodebuild` refuse to run:

```bash
sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
xcode-select -p                             # → /Applications/Xcode.app/Contents/Developer
xcodebuild -version                         # → Xcode 26.6
xcrun --sdk iphoneos --show-sdk-version     # → 26.5
```

If `xcodebuild -version` complains about the licence, run `sudo xcodebuild -license accept`; if the
iOS SDK is absent, `xcodebuild -downloadPlatform iOS`.

### 2. fastlane and CocoaPods

```bash
brew install fastlane cocoapods     # → fastlane 2.238.0, CocoaPods 1.17.0
```

Homebrew rather than `gem`: the system Ruby is 2.6.10 and installing into `/Library/Ruby` is both
awkward and unwise. The brew formulae carry their own Ruby.

### 3. The Apple WWDR **G3** intermediate — the one non-obvious step

A Mac that has never signed an iOS app carries only the original WWDR intermediate, **expired
7 Feb 2023**. Today's `Apple Distribution` certificates chain through **G3**. Without it the build
fails in *Prepare credentials* with a message that blames the certificate:

```text
[PREPARE_CREDENTIALS] Importing distribution certificate into the keychain
[PREPARE_CREDENTIALS] Validating whether the distribution certificate has been imported successfully
Error: Distribution certificate with fingerprint 341AE29C… hasn't been imported successfully
```

The import succeeded. EAS then verifies with `security find-identity -v -s "(4FWU8YBV4X)"`, and
`-v` lists **valid identities only** — an identity whose chain cannot reach a live intermediate is
invisible, so EAS reads that as a failed import. Expo's cloud image ships G3, which is why the same
credentials build fine on EAS and fail here.

```bash
# Diagnose: a single hit with notAfter=Feb 7 2023 is the problem.
security find-certificate -a -c "Apple Worldwide Developer Relations" -p |
  openssl x509 -noout -subject -dates

# Fix — no sudo, no trust prompt (trust comes from Apple Root CA, already trusted).
curl -fsSLO https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer
security import AppleWWDRCAG3.cer -k ~/Library/Keychains/login.keychain-db
```

**Do not regenerate the distribution certificate for a new Mac.** It is account-level: EAS holds the
`.p12` and private key and imports them into a throwaway keychain on every build. Regenerating burns
one of Apple's two Distribution-certificate slots and invalidates the existing provisioning profiles.

### 4. EAS login

```bash
npx eas-cli login
npx eas-cli whoami
```

The `preview` profile is `"distribution": "internal"` — an ad hoc profile with device UDIDs baked
in. The cert and profile already exist on EAS and are reused as-is. A handset that isn't in the
profile needs `pnpm device:register`, then `pnpm build:preview:local:refresh` (see below).

A logged-in session is what makes the build unattended. For CI, export an `EXPO_TOKEN`
(https://expo.dev/settings/access-tokens) instead of logging in.

---

## Running it

```bash
cd apps/mobile
pnpm build:preview:local        # = eas build --local, non-interactive, fixed output path
pnpm ship:preview               # the same build, then uploaded for an install link
```

With `SLACK_WEBHOOK_URL` set (see `.env.example`), the install link is also posted to Slack as a
tappable **Install** button — the quick way onto a phone, since the alternative is retyping a URL.
It is optional and best-effort: unset, the link is only printed, and if Slack rejects the post the
upload has still succeeded, so the command says so and still exits 0. `--no-slack` skips it for a
one-off.

### No prompts, and a predictable filename

The bare `eas build --local` stops twice to ask *"Do you want to log in to your Apple account?"* and
*"…Would you like to reuse the profile?"*, and it names the artifact `build-<timestamp>.ipa`, which
no later step can predict. Three flags remove all of that:

| Flag | Effect |
| --- | --- |
| `--non-interactive` | does all the work. EAS validates the stored cert and profile and returns them, *before* reaching the branch that authenticates with Apple and chooses devices — so both questions are never asked. If they fail validation it errors out instead of prompting |
| `--freeze-credentials` | a guard, not the thing that silences the prompts: it forbids EAS from mutating stored credentials, and makes the `--refresh…` combination below an explicit error rather than a silent conflict |
| `--output <path>` | writes the `.ipa` exactly there, replacing `build-<timestamp>.ipa`. Relative paths resolve against the CWD, and missing parent directories are created |

Verified 2026-10-03: a full `pnpm build:preview:local` ran start to finish with no input and exited 0.

The path defaults to `artifacts/english-tutor-preview.ipa` and is overridable in one place —
`IPA_OUT` is read by both the build and the upload, so they cannot disagree:

```bash
IPA_OUT=artifacts/preview-$(git rev-parse --short HEAD).ipa pnpm ship:preview
```

Install it on a provisioned device over USB:

```bash
xcrun devicectl list devices
xcrun devicectl device install app --device <DEVICE-UDID> ./artifacts/english-tutor-preview.ipa
```

### When a prompt is actually required

Registering a handset (`pnpm device:register`) leaves the ad hoc profile missing that UDID, and
regenerating it needs Apple Developer login. That is the one case `--non-interactive` cannot serve,
so it has its own script — interactive by design, and run once per new device:

```bash
pnpm build:preview:local:refresh    # --refresh-ad-hoc-provisioning-profile, no --freeze-credentials
```

Preview installs alongside the dev and production apps — separate bundle ids, separate data.

### Expected noise — both harmless, both seen in a successful build

- `Failed to read the app config … withAndroidManifestBaseMod: No auth0 scheme specified or package
  found` — the react-native-auth0 plugin's *Android* mod trips over the absent `android.package`
  during config evaluation. eas-cli falls back to its bundled `@expo/config` and continues; it
  cannot affect an iOS build, and cloud builds print it too.
- `Node.js version in your eas.json does not match` — `--local` ignores the `node: "22.13.1"` pin
  and uses whatever is on `PATH` (v24.19.0 here). The build succeeds; only the parity with cloud is
  lost.
- `Command "expo doctor" failed … exited with non-zero code: 1` (2 of 20 checks) — a non-fatal step:
  the build carries straight on to `PREPARE_CREDENTIALS` and exits 0. Do not wire a pipeline to this
  line; use the build's own exit code.

Environment values need no setup and no `.env`: `APP_VARIANT=preview` comes from `eas.json`, and the
four `EXPO_PUBLIC_*` values are pulled from the EAS **preview** environment during config
resolution. Confirm in the log — `[READ_APP_CONFIG]` prints the resolved config, where
`bundleIdentifier` must end in `-preview` and `extra.env` must be fully populated. (Variables stored
with **secret** visibility cannot be read locally and would have to be exported by hand.)

---

## Troubleshooting — what actually went wrong here

| Symptom | Fix |
| --- | --- |
| `xcodebuild requires Xcode, but active developer directory is /Library/Developer/CommandLineTools` | Setup §1 — Xcode is installed but not selected |
| `Distribution certificate with fingerprint … hasn't been imported successfully` | Setup §3 — missing WWDR G3. Not a certificate problem; do not regenerate |
| Build failed and you need the workdir | re-run with `EAS_LOCAL_BUILD_SKIP_CLEANUP=1`, then `rm -rf $TMPDIR/eas-build-local-nodejs/<uuid>` — each run leaves **~5 GB** |

Local builds have no cache: every run recompiles WebRTC/LiveKit and the RN pods from scratch. For
anything you intend to trust or share, prefer cloud `pnpm build:preview` — pinned Node and Xcode, no
drift from this Mac, and a hosted install link.

Related: `docs/2026-08-13-expo-s0-scaffold-testflight.md` (build identity, internal distribution).
