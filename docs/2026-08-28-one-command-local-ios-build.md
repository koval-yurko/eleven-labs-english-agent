# One command, no prompts — the local iOS build

`pnpm build:preview:local` stopped four times to ask a question that had only one sensible answer:

```text
✔ Do you want to log in to your Apple account? … yes
✔ Apple ID: … yurko.free@gmail.com
✔ All your registered devices are present … Would you like to reuse the profile? › Yes   (× 2 targets)
```

All four come from **one** branch in eas-cli, and one flag removes all four:

```diff
-"build:preview:local": "npx eas-cli build --platform ios --profile preview --local",
+"build:preview:local": "npx eas-cli build --platform ios --profile preview --local --non-interactive",
```

Nothing else needs configuring. There is no file to add, no credential to export, no Apple
credential to store on this machine. The rest of this document is *why* that is true, what the flag
quietly gives up, and which knobs are still not defined-once.

---

## 1. The four prompts are one decision, asked twice

Traced through **eas-cli 23.0.0** (`~/.npm/_npx/*/node_modules/eas-cli/build/`).

Prompts 1 and 2 are a single optional step. Before touching credentials, EAS offers to log into
Apple so it can *fully* validate them — `credentials/context.js:80`, reached from
`bestEffortAppStoreAuthenticateAsync`. The name is the whole story: **best effort**. The very first
thing the function does is give up when it can't ask:

```js
// credentials/context.js:69
if (this.nonInteractive) {
  return;
}
```

Prompts 3 and 4 are the same prompt run once per Xcode target — `EnglishTutorPreview` and
`controls`, which is why it appears twice. It lives in `SetUpAdhocProvisioningProfile.js:215`,
reached only from `shouldUseExistingProfileAsync`, which sits *below* an earlier non-interactive
return:

```js
// credentials/ios/actions/SetUpAdhocProvisioningProfile.js:48
const areBuildCredentialsSetup = await this.areBuildCredentialsSetupAsync(ctx);
if (ctx.nonInteractive) {
  if (areBuildCredentialsSetup) {
    return nullthrows(await getBuildCredentialsAsync(ctx, app, IosDistributionType.AdHoc));
  } else {
    throw new MissingCredentialsNonInteractiveError(
      'Provisioning profile is not configured correctly. Run this command again in interactive mode.');
  }
}
```

So `--non-interactive` does not *suppress* the questions — it takes the path where they were never
going to be asked. Credentials that are already correct are used as-is; credentials that aren't fail
loudly with an instruction to re-run interactively. That is exactly the behaviour you want from a
build script.

## 2. Validation still happens — just locally

Losing the Apple session is not losing verification. `validateProvisioningProfileAsync` runs either
way and only the last step is remote:

```js
// credentials/ios/validators/validateProvisioningProfile.js:23
if (!ctx.appStore.authCtx) {
  Log.warn("Skipping Provisioning Profile validation on Apple Servers because we aren't authenticated.");
  return true;
}
```

Everything above that line still runs, offline, against the profile EAS just handed over:

| check | source |
| --- | --- |
| the profile's embedded cert fingerprint matches the `.p12` | `validateDeveloperCertificate` |
| the profile's app id matches this target's bundle identifier | `validateBundleIdentifier` |
| `ExpirationDate` is in the future | inline |

Only *one* thing is dropped: asking Apple whether the profile was revoked or deleted server-side
since EAS stored it. A revoked profile still fails — later, in `[PREPARE_CREDENTIALS]`, where
fastlane verifies the imported identity against the keychain. You get a worse error message, not a
bad `.ipa`.

## 3. Verified end to end

Run 2026-08-28 with the flag, same profile, same Mac:

```text
✔ Using remote iOS credentials (Expo server)
Skipping Provisioning Profile validation on Apple Servers because we aren't authenticated.   (× 2)
Project Credentials Configuration … all credentials are ready
✔ Computed project fingerprint
[PREPARE_CREDENTIALS] Preparing credentials for target 'EnglishTutorPreview'
[PREPARE_CREDENTIALS] Preparing credentials for target 'controls'
```

Zero prompts, both targets signed with the same cert (`341AE29C…`) and the same two profiles as the
interactive run. Nothing was regenerated on Apple's side.

## 4. The one thing you give up: device drift goes quiet

Read the non-interactive branch again — `areBuildCredentialsSetupAsync` never looks at devices.
The device comparison lives *only* in the interactive path:

```js
// SetUpAdhocProvisioningProfile.js:60 — interactive only
if (await this.shouldUseExistingProfileAsync(ctx, buildCredentials)) { … }
```

and that is the function that would otherwise warn:

> The provisioning profile is missing the following devices: …
> Would you like to choose the devices to provision again?

`preview` is `"distribution": "internal"` — an ad hoc profile with UDIDs baked in. **So after
`pnpm device:register`, a `--non-interactive` build will happily produce an `.ipa` the new handset
refuses to install, and say nothing.** Two ways out, both one command:

```bash
# a) drop the flag once, answer "No, let me choose devices again"
npx eas-cli build --platform ios --profile preview --local

# b) stay scripted — refresh the profile from App Store Connect first
npx eas-cli build --platform ios --profile preview --local \
  --non-interactive --refresh-ad-hoc-provisioning-profile
```

(b) is the `build:preview:local:refresh` script. It takes the *other* non-interactive branch
(`SetUpAdhocProvisioningProfile.js:44`), which re-provisions every registered device without asking:

```js
const chosenDevices = ctx.nonInteractive && ctx.refreshAdHocProvisioningProfile
  ? filterDevicesForApplePlatform(registeredAppleDevices, applePlatform)
  : await chooseDevicesAsync(registeredAppleDevices, provisionedDeviceIdentifiers);
```

It does need Apple access, but **not** an interactive login — `ensureAppStoreAuthenticatedForAdhocRefreshAsync`
(`:260`) takes an App Store Connect API key, from env vars or from the key already stored on EAS:

```bash
export EXPO_ASC_API_KEY_PATH=apps/mobile/credentials/AuthKey_3MCAVF3F8F.p8   # already in the repo, gitignored
export EXPO_ASC_KEY_ID=3MCAVF3F8F
export EXPO_ASC_ISSUER_ID=…            # App Store Connect → Users and Access → Integrations
```

Device registration is a rare event. The right default is the fast silent build; reach for the
refresh script on the day you add a handset.

## 5. What is still not defined-once

| input | where it is defined | needed for a cold one-command run? |
| --- | --- | --- |
| Apple ID / password | **nowhere — no longer read** | ✅ solved by §1 |
| distribution cert, both profiles | EAS servers, fetched per build | ✅ already once |
| `EXPO_PUBLIC_*`, `APP_VARIANT` | EAS `preview` environment + `eas.json` | ✅ already once |
| build number | `appVersionSource: "remote"` | ✅ already once |
| **EAS session** | `~/.expo/state.json` via `eas login` | ⚠️ expires; `EXPO_TOKEN` for CI |
| **Node version** | `.nvmrc` = 22.13.1, `eas.json` = 22.13.1 | ❌ `--local` ignores both (§6) |
| **Xcode, fastlane, CocoaPods, WWDR G3** | `Local-build.md` §1–3 | ❌ prose, not code |

The last two are the honest remainder. Neither blocks the build today; both are drift you find out
about the hard way.

**EAS session.** `--local` is not offline: it still fetches credentials, the `preview` environment
variables and the remote build number. The session in `~/.expo/state.json` covers that until it
doesn't. For CI, or to stop thinking about it, mint a robot token
(<https://expo.dev/accounts/[account]/settings/access-tokens>) and export `EXPO_TOKEN`
(`user/SessionManager.js:24`) — it takes precedence over the session file and never expires. It is a
secret, so it belongs in the shell profile or a secret store, not in `apps/mobile/.env`.

**Node version.** Both `.nvmrc` and `eas.json` say 22.13.1; this Mac runs v24.19.0 and the local
build uses it anyway — `--local` honours neither, and only warns:

> Node.js version in your eas.json does not match the Node.js currently installed in your system

Cloud builds get 22.13.1, local builds get whatever `PATH` holds. The `.ipa` produced here is
therefore not bit-identical to the cloud one. That is the standing reason `Local-build.md` ends with
"for anything you intend to trust or share, prefer cloud `pnpm build:preview`". If it ever matters,
the fix is a shell wrapper (`nvm use` is a shell function; an npm script cannot call it), not an
eas.json key.

## 6. The road not taken: `credentialsSource: "local"`

`apps/mobile/credentials.json` already exists, and `eas.json` could point at it:

```json
"preview": { "credentialsSource": "local", … }
```

`IosCredentialsProvider.getLocalAsync()` reads the `.mobileprovision` and `.p12` straight off disk —
no Apple, no EAS credentials fetch, no prompt under any flag. It is tempting and it is worse here:

1. **It is wrong as written.** The file is in single-target shape, which `readIosCredentialsAsync`
   maps onto the application target only, and `ensureAllTargetsAreConfigured` would then reject the
   build for `controls`. You would need the two-target map plus a second `.mobileprovision` that is
   not on this disk:

   ```json
   { "ios": { "EnglishTutorPreview": { … }, "controls": { … } } }
   ```

2. **It buys nothing.** The build still needs the network and the EAS session for the environment
   variables and the remote build number. `--non-interactive` already costs one flag and zero files.

3. **It rots.** Profiles expire and gain devices. Remote credentials are re-fetched every build;
   local ones are a copy you have to remember to refresh with
   `eas credentials` → *Download credentials from EAS to credentials.json* — which is itself an
   interactive menu, i.e. you'd trade four prompts for a periodic errand.

Local credentials are the right answer when the build must run with no EAS account at all. That is
not this repo. Worth noting the file is stale either way: it names
`English_Tutor__Preview_profile.mobileprovision` from 13 Aug, while EAS holds profiles updated 11
days ago.

## 7. Noise worth removing separately

Every run still prints:

```text
Failed to read the app config from the project using the local Expo CLI:
Error: [android.manifest]: withAndroidManifestBaseMod: No auth0 scheme specified or package found
Falling back to the version of "@expo/config" shipped with the EAS CLI.
```

`Local-build.md` correctly calls this harmless for iOS, and it is — but note the third line. The
project's own `@expo/config` never runs; eas-cli reads `app.config.ts` with its *bundled* copy
instead, so the config that decides `bundleIdentifier` and `extra.env` comes from a resolver that is
not the one pinned to Expo 57.

The throw is in `react-native-auth0/plugin/withAuth0.js:82`:

```js
if (config.customScheme == null && applicationId == null) {
  throw new Error(`No auth0 scheme specified or package found in expo config`);
}
```

`applicationId` is `android.package`, and this is an iOS-only config, so it is `null`. Setting
`android: { package: … }` in `app.config.ts` would silence it with **no** effect on iOS output —
the iOS callback scheme is derived from the bundle identifier, and the S2 decision to omit
`customScheme` (D14) is untouched. Adding a dead Android section to a deliberately iOS-only config
is its own small cost; the point of recording it here is that the message is not merely cosmetic, it
means a fallback config resolver. Low priority, separate change.

---

## The result

```bash
pnpm --filter mobile build:preview:local          # ~10 min, 22 MB signed .ipa, zero questions
pnpm --filter mobile build:preview:local:refresh  # same, after registering a new device
```

Related: `apps/mobile/Local-build.md` (host setup, troubleshooting),
`docs/2026-08-13-expo-s0-scaffold-testflight.md` (build identity, internal distribution).
