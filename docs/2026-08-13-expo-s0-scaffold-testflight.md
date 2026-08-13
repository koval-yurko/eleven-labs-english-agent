# S0 — the empty app ships: scaffold, workspace resolution, TestFlight

**Date:** 2026-08-13 · **Status:** **PASSED on 2026-08-13**, on the internal-distribution path. The
Apple/TestFlight leg is deliberately deferred to S7 — see **D9** (§2) and the gate (§7). **D6, D7,
D3, D8, D9 decided (§2).** This is the **only** stage research that is
complete — S2–S7 are placeholders by design (see [How the stage docs work](#how-the-stage-docs-work)).
**S1 was researched on 2026-08-13** and closes both peer questions this file left open — see the
callout in §2 D8.

**Parent documents.** The build order is [`2026-08-12-expo-build-plan.md`](./2026-08-12-expo-build-plan.md)
(S0 section); the reasoning is [`2026-08-12-expo-app-creation.md`](./2026-08-12-expo-app-creation.md)
(§7 scaffold, §8 the ladder). This file does not re-argue either. It is the executable detail for one
stage: what to decide before typing, what to type, what can go wrong, and what S1 inherits.

---

## How the stage docs work

One research file per stage, numbered:

| Stage | File                                                                            | State          |
| ----- | ------------------------------------------------------------------------------- | -------------- |
| S0    | this file                                                                       | **researched** |
| S1    | [`…-expo-s1-background-audio.md`](./2026-08-13-expo-s1-background-audio.md)     | **researched** |
| S2    | [`…-expo-s2-auth0-bearer.md`](./2026-08-13-expo-s2-auth0-bearer.md)             | placeholder    |
| S3    | [`…-expo-s3-conversation-token.md`](./2026-08-13-expo-s3-conversation-token.md) | placeholder    |
| S4    | [`…-expo-s4-tutor-screen.md`](./2026-08-13-expo-s4-tutor-screen.md)             | placeholder    |
| S5    | [`…-expo-s5-lessons.md`](./2026-08-13-expo-s5-lessons.md)                       | placeholder    |
| S6    | [`…-expo-s6-collection.md`](./2026-08-13-expo-s6-collection.md)                 | placeholder    |
| S7    | [`…-expo-s7-ship.md`](./2026-08-13-expo-s7-ship.md)                             | placeholder    |

**Why only S0 is researched.** Each stage's real questions are the ones the previous stage's _result_
poses. Researching S4's tutor screen today would mean writing against an unproven SDK on an unproven
build — and every line of it would have to be re-checked after S1 says whether a locked screen keeps
the session, and after S3 says which `conversation_id` the webhook actually reports. So each
placeholder carries only what is genuinely already decided, plus **the list of facts it needs handed
over from the stage before it**. Fill one in when the previous gate goes green, not before.

---

## 1. What S0 exists to answer

Three questions, none of them about our product code — which is exactly why they come first:

1. **Does Metro resolve `@tutor/shared`?** The package ships **raw TypeScript through subpath
   exports** under a **hoisted pnpm** layout. Every screen in this project depends on that working.
2. **Does EAS build this monorepo?** pnpm 11, `workspace:*` protocol, a lockfile at the repo root and
   an app two directories down.
3. **Does the Apple pipeline work end to end?** Bundle identifier → signing → provisioning →
   App Store Connect record → upload → processing → installable from TestFlight.

A failure in any of them at S1 means debugging two unrelated things at once, and the one you care
about is the one you will misdiagnose.

---

## 2. Decisions — settled 2026-08-13

All five are **decided**. D8 was raised and closed on 2026-08-13 against the published peer ranges;
D9 was raised and closed the same day, after the first device install.

### D6 — the template: `default` ✅

`--template default`. The build plan's `blank-typescript` line is superseded — the default template
wires `expo-router` (the decided navigation model, creation doc §6), typed routes, `expo-linking`,
`react-native-screens`, `react-native-safe-area-context` **and `@expo/ui`** in one pass, which is
exactly the set D3 now commits us to. Retrofitting any of it at S4/S5 means changing the app's entry
point in the stages where you want zero unexplained variables.

The cost is that "the empty app" is not literally empty: strip the stock tabs to one screen. The
template ships a `reset-project` script — check `apps/mobile/package.json` before deleting by hand.
That is throwaway _content_, not a throwaway _project_.

### D7 — identity: one EAS project, three variants ✅

| Variant     | `APP_VARIANT` | Bundle identifier                            | Display name            | URL scheme (= Auth0 `customScheme`) | Distribution            |
| ----------- | ------------- | -------------------------------------------- | ----------------------- | ----------------------------------- | ----------------------- |
| development | `development` | `work.kovalchuk.yurii.english-tutor-dev`     | English Tutor (Dev)     | `englishtutordev`                   | internal, dev client    |
| preview     | `preview`     | `work.kovalchuk.yurii.english-tutor-preview` | English Tutor (Preview) | `englishtutorpreview`               | internal, release build |
| production  | _unset_       | `work.kovalchuk.yurii.english-tutor`         | English Tutor           | `englishtutor`                      | store → TestFlight      |

**Invariant across all three, and immutable:** EAS project name **English Tutor**, `slug`
**`english-tutor`**, one `extra.eas.projectId`. Variants share an EAS project by design — only the
bundle identifier, the display name and the scheme differ. Changing the slug per variant would
fragment the project into three and break `eas build --profile`.

Four consequences follow, and three of them are work:

1. **`app.json` becomes `app.config.ts`.** A static config cannot express three identities. This
   moves to S0 something the plan had assumed was a later concern.
2. **The scheme varies too, and that is not optional.** The point of variants is dev and production
   installed on the same phone; two apps registering `englishtutor://` leaves iOS to pick one, and
   which one is undefined. Since the Auth0 callback embeds both scheme and bundle id
   (`{customScheme}://{domain}/ios/{bundleIdentifier}/callback`), a shared scheme surfaces at S2 as
   "login succeeds and the app never comes back" — a failure that looks like Auth0 and is not.
   Lowercase, no separators, per the plugin's constraint.
3. **Auth0 gets three callback URLs, not one** — same single Native application, comma-separated in
   _Allowed Callback URLs_ and _Allowed Logout URLs_. S2's file must inherit all three (§9).
4. **Only production needs an App Store Connect record.** Development and preview are internal
   distribution: registered device UDIDs (`eas device:create`) and an ad-hoc profile, no ASC app, no
   TestFlight. **The S0 gate is therefore the production variant** — it is the only one that can
   answer question 3 of §1.

**Unset means production, and that is deliberate.** `npx testflight`, `npx expo prebuild` and any
command run without the variable must produce the identity that reaches the App Store; a build that
silently ships under a `-dev` bundle id is the expensive failure. An _unrecognised_ value must throw
rather than fall back — the same rule as `appEnv` in `CLAUDE.md` ("required, never defaulted"). The
inverse trap: `npx expo run:ios` locally with no variable set installs the **production** bundle id
over your TestFlight build. Put `APP_VARIANT=development` in `apps/mobile/.env` for local work; EAS
never sees that file (it is gitignored, §5), which is exactly why `eas.json` sets the variable per
profile.

```ts
// apps/mobile/app.config.ts
import type { ExpoConfig } from "expo/config";

const VARIANTS = {
  development: { suffix: "-dev", name: "English Tutor (Dev)", scheme: "englishtutordev" },
  preview: { suffix: "-preview", name: "English Tutor (Preview)", scheme: "englishtutorpreview" },
  production: { suffix: "", name: "English Tutor", scheme: "englishtutor" },
} as const;

const key = process.env.APP_VARIANT ?? "production"; // unset → production, by design
if (!(key in VARIANTS)) throw new Error(`Unknown APP_VARIANT: ${key}`); // typo → hard stop
const v = VARIANTS[key as keyof typeof VARIANTS];

export default (): ExpoConfig => ({
  name: v.name,
  slug: "english-tutor", // one EAS project — never varies
  scheme: v.scheme, // deep links; Auth0's customScheme must match (S2)
  ios: {
    bundleIdentifier: `work.kovalchuk.yurii.english-tutor${v.suffix}`,
    infoPlist: { ITSAppUsesNonExemptEncryption: false }, // §5
  },
});
```

`NSMicrophoneUsageDescription`, `UIBackgroundModes` and the LiveKit / WebRTC / Auth0 plugins are
**not** added here — each belongs to the stage whose gate tests it (§6). When S2 adds the
`react-native-auth0` plugin it reads `v.scheme`, not a literal.

### D3 — component strategy: Expo UI ✅

**Expo UI** (`@expo/ui`). The SwiftUI and Jetpack Compose APIs went stable in SDK 56 after three
cycles of iteration, and the package now ships in the default `create-expo-app` template — so D6 and
D3 cost nothing together. iOS-only per D2 means the one part still labelled experimental (the web
implementations behind `@expo/ui/universal`) is out of scope; import from `@expo/ui/swift-ui`.

What this decision actually buys and costs, recorded now so S6 does not rediscover it:

- **`Host` is the boundary.** RN and Yoga outside it, SwiftUI layout inside. A `Host` behaves like a
  `View` and **needs explicit dimensions** (`style={{ flex: 1 }}`, a width) or `matchContents`.
- **The trap that will bite S6 specifically:** never put `matchContents` on the same axis as a
  SwiftUI scroll container (`ScrollView`, `List`, `Form`, `LazyVStack`). It resolves to
  `.fixedSize`, the container sizes to its content, and **scrolling silently stops working** — no
  error, on the project's longest screen.
- **`matchContents` only works for intrinsically-sized content** (`Text`, `Button`, `Toggle`), not
  for flexible ones (`Slider`, `ProgressView`).
- **Open for S6, not for now:** one `Host` per row inside a `FlatList` is the naive port of the web
  list and is the wrong shape; a single `Host` wrapping a SwiftUI `List` is the likely answer. That
  is S6's research, and it is now a concrete question rather than an open strategy.
- Expo UI is in Expo Go, which is moot: S1 needs a dev client regardless (creation doc §7).
- The 2630 LOC of Base UI components do not port either way (creation doc §6); this decision only
  chooses what they are rebuilt _against_.

**S0 must render one Expo UI component**, not just `Text`. It is a native module: proving it builds,
links and renders in an EAS build costs one line here and is otherwise discovered at S6, five stages
from its cause.

### D8 — Expo SDK: **57** ✅ (decided 2026-08-13, peer ranges verified)

SDK 57 shipped 2026-06-30 — RN 0.86, React 19.2.3, and a deliberately small release: RN 0.86 is
"intended to have no breaking changes from 0.85". `npx create-expo-app@latest` scaffolds it today, so
this is also the path of least resistance.

**Nothing in the S1 stack declares an upper bound on React Native.** Verified against the npm
registry on 2026-08-13:

| Package                               | Latest  | Declared peers that matter                  | RN 0.86? |
| ------------------------------------- | ------- | ------------------------------------------- | -------- |
| `@elevenlabs/react-native`            | 1.2.18  | `react-native: >=0.70.0`, `react: >=17.0.0` | ✅       |
| `@livekit/react-native`               | 2.12.0  | `react-native: *`, `react: *`               | ✅       |
| `@livekit/react-native-webrtc`        | 144.1.2 | `react-native: >=0.60.0`                    | ✅       |
| `@livekit/react-native-expo-plugin`   | 1.0.2   | `expo: *`, `react-native: *`                | ✅       |
| `@config-plugins/react-native-webrtc` | 15.0.1  | **`expo: ^56`**                             | ⚠️ §3    |

So the SDK is clear on the axis D8 was about. Two things the same query turned up are **not** clear,
and both are S1's problem rather than S0's — recorded here because they were found here:

**⚠️ The WebRTC config plugin has no SDK 57 release.** `@config-plugins/react-native-webrtc` ships
one major per SDK (14 → `expo: ^55`, 15 → `expo: ^56`) and 15.0.1 is latest. On SDK 57 its peer is
unmet: pnpm warns rather than fails, and the plugin only patches iOS build settings, so it will
probably work — but "probably" is a native prebuild, which is exactly what S1's gate exists to
de-risk. If `npx expo prebuild` breaks on it, the fallback ladder is: wait for the 16.x release →
override the peer → drop to SDK 56. Do not spend S1's gate discovering this; check for a 16.x
release the day S1 starts. **Re-checked 2026-08-13 (same day, after the scaffold): still 15.0.1,
still `expo: ^56`. No 16.x yet** — S1 starts with this unresolved.

**⚠️ ElevenLabs pins the LiveKit trio to the previous line, and the latest LiveKit contradicts it.**
`@elevenlabs/react-native@1.2.18` peers `@livekit/react-native: ^2.9.2` **and**
`@livekit/react-native-webrtc: ^137.0.2` — but `@livekit/react-native@2.10.0` moved to webrtc
`^144`. The `^2.9.2` range therefore resolves to 2.12.0, which drags in webrtc 144 and **violates
ElevenLabs' own webrtc peer**. Today's only jointly-satisfying set:

```text
@livekit/react-native@2.9.x + @livekit/react-native-webrtc@137.x + livekit-client@^2.15.4
```

`npx expo install` picks SDK-matched versions, not peer-consistent ones, so it will not resolve this
for you. S1 installs the pinned trio above and treats the mismatch as a known state — 137 and 144
are different libwebrtc binaries, so this is a native-linkage question, not a semver quibble.

> **⚠️ Superseded 2026-08-13 by [S1 §2 D10](./2026-08-13-expo-s1-background-audio.md#d10--the-dependency-set-and-the-real-reason-for-it-)** —
> the conflict is real, the cause is not. Reading the sources shows the private APIs ElevenLabs
> depends on (`createVolumeProcessor`, `_peerConnectionId`) are **identical** across 137 and 144;
> what actually binds is that `@elevenlabs/client@1.17.0` depends on **`livekit-client` at exactly
> `2.16.1`**, which `@livekit/react-native@2.9.8` (`^2.15.8`) satisfies and `2.12.0` (`^2.19.0`) does
> not — two copies of `livekit-client`, two `Room` classes, in one process. **`^2.15.4` above is
> wrong**: a caret resolves to 2.21.0 and produces exactly that duplicate. Pin `2.16.1`, exact. The
> `@config-plugins/react-native-webrtc` warning also resolved to a non-issue — its whole source is
> two Info.plist strings, a bitcode no-op and Android permissions.

### D9 — TestFlight deferred to S7; S0 ships on internal distribution ✅

**Decided 2026-08-13, after a `preview` build ran on a real device.** The Apple Developer / App Store
Connect side is not set up, and setting it up is not what this project needs next. Development and
preview builds are enough to carry S1–S6.

**What this costs, stated honestly.** §1's third question — "does the Apple pipeline work end to
end?" — goes unanswered until S7. That is a real deferral, and this file previously said "resolve
fully before S1 — do not carry it forward". The reason it is nevertheless the right call now is that
the residual is **not code**:

| Differs between preview and production                                        | Is it our code?              |
| ----------------------------------------------------------------------------- | ---------------------------- |
| Distribution certificate + provisioning profile (ad-hoc → App Store)          | no — Apple credentials       |
| An App Store Connect app record for `work.kovalchuk.yurii.english-tutor`      | no — Apple account admin     |
| Upload, processing, TestFlight groups                                         | no — Apple infrastructure    |
| `appVersionSource: remote` + `autoIncrement`                                  | **eas.json, and untested**   |
| Everything else — bundle, native modules, config plugins, signing _mechanics_ | **already proven on device** |

A preview build is a Release configuration with the JS bundle embedded and Hermes-compiled, ad-hoc
signed and installed on real hardware. The one thing it does not exercise is the store-distribution
identity — so what remains is paperwork plus one untested `eas.json` field, not an unknown in the
build.

**What it means for the stages that follow:**

- **S1–S6 run on `preview`**, which is the right instrument anyway: B2 (background audio) must be
  measured on a Release build, never a dev client. The loop is **5 minutes** end to end.
- **`development` needs `expo-dev-client`**, which is not installed yet — S1 adds it with the
  ElevenLabs and LiveKit modules. Until then `pnpm build:dev` will not produce a usable dev client.
- **Ad-hoc profiles embed device UDIDs.** A new or reset device means `eas device:create` **and a
  rebuild** — an internal build cannot install on a device that was not registered when it was made.
- **S7 inherits the whole Apple leg**, and it is now the stage with an unproven prerequisite rather
  than a polish pass. Its first gate is no longer "shippable", it is "does an upload work at all".

## 3. Versions — one React, and what can silently fight it

| Thing               | Value                                        | Where                                  |
| ------------------- | -------------------------------------------- | -------------------------------------- |
| Expo SDK            | **57** (RN 0.86, React 19.2.3) — D8, decided | this file §2                           |
| React               | **19.2.3 everywhere** — see below            | `pnpm-workspace.yaml` → `overrides`    |
| Node                | ≥ 22, and **SDK 57 requires ≥ 22.13**        | root `package.json` → `engines`        |
| Package mgr         | **pnpm 11.20.0**                             | root `package.json` → `packageManager` |
| Node linker         | `hoisted`, `hoistingLimits: workspaces`      | `pnpm-workspace.yaml`                  |
| Xcode               | 26.4 minimum (since SDK 56)                  | Expo SDK 56 changelog                  |
| iOS deployment tgt. | 16.4 minimum (raised from 15.1 in SDK 56)    | Expo SDK 56 changelog                  |

### The React version is 19.2.3, workspace-wide

**One version for both apps, and React Native chooses it.** `react-native@0.86` declares
`peerDependencies.react: "^19.2.3"` and Expo SDK 57 pins exactly **19.2.3**; Next 16.2.7 asks only
for `^19.0.0`. There is therefore no conflict to arbitrate — the mobile side has the tighter
constraint and the web side is indifferent, so the workspace takes the number RN requires. Keeping
one React across the repo is the stated intent of the override (`pnpm-workspace.yaml`), and this
keeps it true rather than working around it.

The repo currently resolves **19.2.7** everywhere. The change is three lines:

```diff
  # pnpm-workspace.yaml
  overrides:
-   react: 19.2.7
-   react-dom: 19.2.7
+   react: 19.2.3      # = react-native@0.86 peer (^19.2.3) and Expo SDK 57's pinned version
+   react-dom: 19.2.3
```

```diff
  // apps/web/package.json — declared ranges must not contradict the override
-   "react": "^19.2.7",
-   "react-dom": "^19.2.7",
+   "react": "19.2.3",
+   "react-dom": "19.2.3",
```

Exact, not `^`: a caret range plus an exact override is two sources of truth, and `pnpm update` would
move the range while the override silently pinned the result. This is a **downgrade for the web app**
(19.2.7 → 19.2.3, four patch releases) — deliberate, and the reason to do it at S0 rather than
after mobile code exists. When a future SDK 57 patch bumps its React, bump both places together.

- [x] **Applied 2026-08-13, ahead of the scaffold** — the workspace already resolves 19.2.3
      everywhere (`pnpm-workspace.yaml` + `apps/web/package.json`). Web was re-verified after the
      downgrade: `pnpm build` ✅, `pnpm typecheck` ✅, `pnpm lint` ✅, `pnpm check:shared` ✅. S0 does
      not repeat this; it only confirms mobile lands on the same number.
- [x] `pnpm why react` → a single `react@19.2.3` across the whole workspace, web and mobile alike.
- [x] `npx expo-doctor` from `apps/mobile` — 20/20, no React version mismatch. This, not `pnpm why`,
      is what knows the SDK's expectations.
- [x] `pnpm build` for web passes after the downgrade.
- [x] `pnpm config get node-linker` → `hoisted` (the pnpm-9-fails-silently check from `CLAUDE.md`).
- [ ] Local Node is 22.13.1 — **exactly** SDK 57's floor. `nvm`-style version drift downward now
      breaks the mobile toolchain, not just a warning.

**Do not** pin React in `apps/mobile/package.json` while the override exists: the override wins and
the declared version becomes decoration.

## 4. The gate that actually matters — Metro resolving `@tutor/shared`

### What the package ships

```jsonc
// packages/shared/package.json — verified 2026-08-13
{
  "type": "module",
  "main": "./src/index.ts", // raw TypeScript, not a build output
  "exports": { ".": "./src/index.ts", "./*": "./src/*.ts" },
  "dependencies": {}, // empty, and must stay empty
}
```

Four things must line up, and each has a distinct failure signature:

| #   | Requirement                                              | Status                                                                                                     | If it breaks                                              |
| --- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 1   | Metro **package exports** support (for `"./*"` subpaths) | on by default since RN 0.79 → expected fine on 0.85                                                        | `Unable to resolve module @tutor/shared/tutor`            |
| 2   | Metro transpiles `.ts` from **outside** the app dir      | SDK 52+ configures monorepo `watchFolders` automatically                                                   | `SyntaxError: Unexpected token` on a type annotation      |
| 3   | Hoisted pnpm layout + workspace symlink                  | `nodeLinker: hoisted` already set; `@tutor/shared` stays a symlink into `packages/shared`                  | resolution finds nothing, or finds it and cannot watch it |
| 4   | The TS in `src/` is per-file transpilable                | **verified**: no `enum`, no `namespace`, no `declare`, no `node:` imports; `isolatedModules` is already on | Babel strips types per file and cannot see across modules |

Requirement 4 is not luck — `packages/shared/tsconfig.json` sets `isolatedModules` and
`verbatimModuleSyntax` and excludes `@types/node` via `types: []`, so the core is _compile-time_
guaranteed to be the kind of TypeScript Babel can transform one file at a time. That is the same
property Metro needs. Keep it that way: a `const enum` added to `src/` later would break the mobile
build and nothing else.

### The rule about `metro.config.js`

**Ship the generated file untouched.** SDK 52+ handles monorepos automatically; the `watchFolders` /
`extraNodeModules` snippets you will find in older answers _cause_ the bugs they claim to fix. The
**one** permitted hand-edit in this whole plan:

```js
config.resolver.unstable_enablePackageExports = true; // only if subpath resolution fails
```

### Prove it with the subpath, not the barrel

```tsx
import { KICKOFF_MESSAGE } from "@tutor/shared/tutor";
// …
<Text>{KICKOFF_MESSAGE}</Text>;
```

Import the **subpath** (`/tutor`), not the barrel (`@tutor/shared`). The barrel resolves via
`exports["."]` and would pass even if `exports["./*"]` were broken — and the subpath form is what
every real screen uses, per `CLAUDE.md`'s convention ("import it by name and by module").

### The TypeScript side is a separate check

Metro resolving it at runtime and `tsc` resolving it for the editor are two different resolvers.
Expo's base tsconfig uses `moduleResolution: "bundler"`, which honours `exports`, so this is expected
to work — but confirm it, because a red editor for six weeks is its own tax.

- [ ] `pnpm typecheck` from the repo root passes **with `apps/mobile` included** in the recursive run.
- [ ] No `paths` mapping added unless the above actually fails.

---

## 5. EAS, App Store Connect and TestFlight

### The file

```jsonc
// apps/mobile/eas.json
{
  "cli": { "version": ">= 21.0.0", "appVersionSource": "remote" },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal",
      "node": "22.13.1",
      "env": { "APP_VARIANT": "development" }, // → work.kovalchuk.yurii.english-tutor-dev
    },
    "preview": {
      "distribution": "internal",
      "node": "22.13.1",
      "env": { "APP_VARIANT": "preview" }, // → …english-tutor-preview
    },
    "production": {
      "distribution": "store",
      "node": "22.13.1",
      "autoIncrement": true,
      // no APP_VARIANT — unset means production (D7)
    },
  },
  "submit": {
    "production": {
      "ios": {
        "appleTeamId": "4FWU8YBV4X", // known now; not a secret
        // "appleId" / "ascAppId" — added once the App Store Connect record exists (below)
      },
    },
  },
}
```

- **`env.APP_VARIANT`** is what makes D7's three identities real on EAS. `.env` is gitignored and
  never reaches a cloud build, so the profile is the only place the variant can come from — and the
  production profile asserts the default by saying nothing.
- **`node` must be an EXACT version — a range is rejected.** `"22.x"` fails eas.json validation with
  _"failed custom validation because 22.x is not a valid version"_, and the error arrives after the
  login prompt, so it reads like an account problem. Use the version you actually run locally
  (`22.13.1` here, above SDK 57's ≥ 22.13 floor); local/cloud parity is the entire point of the
  field, and leaving it to the image default is how you get a build that works locally and fails in
  the cloud. **Corrected 2026-08-13** — this file previously said `22.x`.
- **`cli.version`** is a floor with a purpose: `eas-cli` versions independently of the SDK, `npx`
  prefers whatever is on `PATH`, and this machine was carrying a **five-major-stale global 16.13.4**
  while `npx eas-cli` would have fetched 21.8.0 — two different CLIs depending on how you typed the
  command. `>= 21.0.0` turns that into an error rather than a divergence. (Fixed 2026-08-13 with
  `npm install -g eas-cli@latest`.)
- **`appVersionSource` + `autoIncrement`** — set one of them explicitly. Without it the _second_
  upload is rejected for a duplicate `ios.buildNumber`, which reads like a signing failure and is not.
- **Package manager.** eas-cli infers pnpm from the root `pnpm-lock.yaml`. If it misdetects
  ([eas-cli#2978](https://github.com/expo/eas-cli/issues/2978)), pin it in the build profile —
  `"corepack": true` (root `packageManager` is already `pnpm@11.20.0`) or an explicit `"pnpm"`
  version field.

### A dynamic config cannot be written to

`eas init` writes `extra.eas.projectId` into a **static `app.json`**. D7 replaced that with
`app.config.ts`, so the CLI cannot write it and the id must be added by hand:

```ts
extra: { eas: { projectId: "…" } },
```

One project id for all three variants — never one per variant. Confirm with
`npx eas-cli config --platform ios --profile <name>`, which prints the fully resolved config and the
build profile without building anything. It is the only way to see what a profile will actually
produce before spending twenty minutes finding out.

**It also confirmed the variant machinery end to end:** `--profile production` resolves to
`English Tutor` / `work.kovalchuk.yurii.english-tutor` / `englishtutor` **even with
`APP_VARIANT=development` sitting in `.env`** — eas-cli does not read `.env` at all, unlike
`expo export` and `expo-doctor`, which announce `env: load .env`. A production build cannot pick up a
local variant by accident.

### The fastest path for the first build

SDK 56 ships `npx testflight`, an interactive command that does EAS project init, bundle-id
confirmation, credential generation (distribution certificate + provisioning profile), a production
build, App Store Connect verification and the upload — in one pass. It needs a paid Apple Developer
account and an Expo account. Use it for the _first_ build; use
`eas build -p ios --profile production` + `eas submit -p ios --latest` from then on, because those
are what a CI step will eventually run.

**With D7 in place, run it with a clean environment.** `npx testflight` sets no `APP_VARIANT`, which
is precisely why unset means production — but a stray `APP_VARIANT` in your shell or in
`apps/mobile/.env` would silently build the dev identity and submit it. Confirm the bundle
identifier it prints at step 2 before letting it continue; that prompt is the gate on this whole
decision. It reuses an existing EAS project's slug rather than creating a new one, so it is safe to
run after `eas init`.

### Traps worth knowing before losing a day

- **EAS uploads via git.** Uncommitted and gitignored files do **not** reach the build. `apps/mobile`
  must be committed before the first build, and `apps/mobile/.env` will _not_ be there — irrelevant at
  S0 (no env needed), load-bearing at **S1**, which needs `EXPO_PUBLIC_AGENT_ID`. Plan on EAS
  environment variables (`eas env`) rather than the local `.env` from S1 onward.
- **`.easignore`** is discovered by walking up from the app directory to the git root, with patterns
  scoped per-directory — so it can live at `apps/mobile/.easignore` or at the repo root. Useful for
  excluding `apps/web` from the upload; not required to pass S0.
- **Run eas commands from `apps/mobile`.** EAS detects the workspace root and installs there.
- **Export compliance.** Add `ios.infoPlist.ITSAppUsesNonExemptEncryption: false` if — and only if —
  the app uses nothing beyond standard HTTPS, which is true here. Without it every single upload
  lands in App Store Connect as "Missing Compliance" and cannot be distributed to testers until you
  answer the questionnaire by hand. It is a legal declaration, so make it deliberately, not by copy-paste.
- **App Store Connect API key** beats an Apple ID + app-specific password for `eas submit`;
  two-factor prompts do not belong in a build loop.
- **The three `submit.production.ios` fields are not equivalent.** `appleTeamId` (`4FWU8YBV4X`) is
  known before anything exists and is safe to commit — it appears on every provisioning profile and
  is not a credential. `appleId` is the account email. **`ascAppId` is the one that matters for
  automation**: it is the numeric App Store Connect app id, it only exists after the app record is
  created, and supplying it is what lets `eas submit` skip the "does this app exist?" round trip and
  run non-interactively. Fill it in after the first upload.
- **Processing takes 5–30 minutes** after upload. Internal testing groups need no Beta App Review;
  external ones do. Stay internal for S0–S3.

---

## 6. Steps

Executed 2026-08-13. What the scaffold actually did, including four things the research did not
predict — each marked **↯**.

- [x] `cd apps && npx create-expo-app@latest mobile --template default --no-install` → **SDK 57.0.12,
      RN 0.86.2, react 19.2.3**. `--no-install` deliberately: let the root `pnpm install` own the
      tree rather than letting npm create a nested one.
- [x] **↯ Three steps were already done by the template**: `"name": "mobile"`, `@expo/ui@~57.0.10` in
      `dependencies` (D3 confirmed — it did ship in the default template), and `react: 19.2.3`
      **exactly** — the number §3 derived from RN's peer range, written by the template itself.
- [x] **↯ The app directory is `src/app/`, not `app/`** — SDK 57's default template nests the router
      root under `src/`, with `@/*` → `./src/*` in `tsconfig.json`.
- [x] Stripped to one screen by hand: deleted `src/components`, `src/constants`, `src/hooks`,
      `src/global.css`, `explore.tsx`, `scripts/`, the template `README`/`LICENSE`, and every asset
      except the icon and splash. `_layout.tsx` is now a bare `Stack`.
- [x] `"@tutor/shared": "workspace:*"` added to `dependencies`
- [x] Added `"typecheck": "tsc --noEmit"`; dropped `android` / `web` / `reset-project` scripts (D2).
      The template already had a `lint` script (`expo lint`), replaced with `eslint .` plus an
      `eslint.config.js` extending `eslint-config-expo/flat`, to match `apps/web`.
- [x] **↯ `unrs-resolver` must be added to `allowBuilds` in `pnpm-workspace.yaml`.** It is the native
      resolver behind `eslint-config-expo`'s import plugin, and pnpm 10+ blocks its postinstall.
      This does not warn — pnpm's deps-status check **exits non-zero**, so `pnpm typecheck` in
      `apps/mobile` dies before `tsc` ever runs, with an error naming neither TypeScript nor ESLint.
- [x] `app.config.ts` written from §2 (three variants, slug `english-tutor`,
      `ITSAppUsesNonExemptEncryption: false`); `app.json` deleted
- [x] `eas.json` written from §5, with `env.APP_VARIANT` per profile
- [x] `apps/mobile/.env` → `APP_VARIANT=development`; confirmed gitignored by the **root**
      `.gitignore` (bare `.env` matches at any depth), and `expo-doctor` prints `env: load .env` →
      `env: export APP_VARIANT`, so the local dev identity works as designed
- [x] **↯ There is no `metro.config.js` to ship untouched** — SDK 57's template does not generate
      one at all. The rule becomes stronger, not weaker: **do not create one.**
- [x] `KICKOFF_MESSAGE` rendered from `@tutor/shared/tutor` inside an Expo UI `Host`, with the
      resolved bundle identifier on screen so a TestFlight install can be checked against D7 by eye
- [x] **↯ Expo UI text takes no style props.** `Text` has no `size` / `weight` / `color`; styling is
      `modifiers={[font({size, weight, design}), foregroundStyle({type: "hierarchical", …})]}` from
      `@expo/ui/swift-ui/modifiers`. Caught by `tsc`, not at runtime. **S6 inherits this.**
- [x] `pnpm install` at the root → `apps/mobile/node_modules` is flat (544 entries), `@tutor/shared`
      a symlink to `packages/shared`, `react` 19.2.3
- [x] `npx expo-doctor` → **20/20 checks passed, no issues** — in particular no React version
      complaint, which is what §3 predicted
- [x] `pnpm typecheck` and `pnpm lint` from the root → `Scope: 3 of 4 workspace projects`, both
      naming `mobile`. The `typecheck` script addition is what makes that true.
- [x] **↯ `npx expo export --platform ios` proves §1's first question without Apple.** It runs the
      real Metro pipeline: bundled 1230 modules, and the Hermes output contains the literal
      `KICKOFF_MESSAGE` string — so the subpath export resolved, raw TypeScript from outside the app
      directory transpiled, and the constant survived into the bundle. **No
      `unstable_enablePackageExports` was needed.** Run this before every EAS build; it costs six
      seconds and it is the same failure surface as the cloud build, minus the twenty-minute wait.
- [x] Commit `apps/mobile` (EAS uploads via git — §5)
- [x] **A `preview` build was made and installed on a real device** (2026-08-13): EAS build #1,
      internal distribution, **5 minutes** wall clock, iOS **26.4** device. A second preview build was
      cancelled, so `autoIncrement` is still unproven (production-only setting).
- [→] `npx testflight` / `eas build --profile production` → `eas submit` — **deferred to S7 (D9)**:
  needs an Apple Developer account and App Store Connect setup that does not exist yet
- [→] Install from TestFlight on the target device — **deferred to S7 (D9)**

**Do not add in this stage:** ElevenLabs, LiveKit, Auth0 (and its plugin/`customScheme` wiring),
`UIBackgroundModes`, `NSMicrophoneUsageDescription`, any `/api/v2/*` route. Each belongs to the stage
whose gate tests it. The development and preview **builds** are also not needed at S0 — the profiles
exist in `eas.json`, but only production is exercised here.

---

## 7. Gate

Status 2026-08-13. **A `preview` build on a real device closed four of the six lines** — worth more
than it sounds, because a preview build is a Release configuration with the JS bundle embedded, so
what ran on that phone is the production code path in everything but signing.

- [x] **Displays the string imported from `@tutor/shared/tutor`** — confirmed on device: "Let's
      begin. Greet me in one sentence and start teaching the first item now."
- [x] **An Expo UI component renders inside a `Host`** — confirmed on device. Every glyph on that
      screen is SwiftUI behind `@expo/ui/swift-ui`, so seeing _any_ text proves the native module
      compiled, linked and rendered in a cloud build. D3 is de-risked five stages before S6 needs it.
- [x] Root `pnpm typecheck` + `pnpm lint` pass **and the output shows `mobile`** —
      `Scope: 3 of 4 workspace projects`.
- [x] Installs on the target device and launches (iOS 26.4, well above the 16.4 floor).
- [ ] **Installs from TestFlight** — still open. What is installed is
      `work.kovalchuk.yurii.english-tutor-preview`, ad-hoc signed via internal distribution. That
      proves EAS builds this monorepo; it does **not** prove the Apple leg: App Store Connect record →
      store-signed upload → processing → TestFlight. That leg is §1's third question and the whole
      reason S0 exists as a stage.
- [ ] The installed app is `work.kovalchuk.yurii.english-tutor`, named **English Tutor** — the
      production identity (D7). The preview install did confirm the variant machinery works end to
      end, since the screen printed the `-preview` identifier it was built with.
- [ ] A second build uploads without a version collision (proves `autoIncrement`). Both preview
      builds carried `build#1` — `autoIncrement` is set on the production profile only, so this is
      genuinely untested.

**The two open lines are deferred to S7 by D9, not failed.** Both depend on an Apple Developer / App
Store Connect setup that does not exist yet, and neither is a property of our build: a preview build
is the same Release binary with a different signing identity. What S1 must not do is quietly assume
they passed — the ladder's rule was "resolve signing before S1", and this is an explicit, recorded
exception rather than a forgotten one.

---

## 8. If it fails

| Symptom                                                                                  | Cause / next move                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Unable to resolve module @tutor/shared/tutor`                                           | Package exports. Set `config.resolver.unstable_enablePackageExports = true` — the one permitted `metro.config.js` edit.                                                                                                                     |
| `SyntaxError: Unexpected token` inside `packages/shared`                                 | Metro is not transpiling outside the app dir. Do **not** hand-write `watchFolders`; check the SDK version first.                                                                                                                            |
| Resolution works, editor is red                                                          | tsc, not Metro. Check `moduleResolution: "bundler"` in `apps/mobile/tsconfig.json` before adding `paths`.                                                                                                                                   |
| Two Reacts at runtime (`Invalid hook call`)                                              | The override lost. `pnpm why react`; fix the override rather than the app.                                                                                                                                                                  |
| EAS picks the wrong package manager                                                      | [eas-cli#2978](https://github.com/expo/eas-cli/issues/2978) — pin `corepack`/`pnpm` in the build profile.                                                                                                                                   |
| Build fails only in the cloud                                                            | Node version drift. Pin `"node": "22.13.1"` per profile.                                                                                                                                                                                    |
| Second upload rejected, duplicate build number                                           | `appVersionSource` / `autoIncrement` not set.                                                                                                                                                                                               |
| Build stuck at "Missing Compliance"                                                      | `ITSAppUsesNonExemptEncryption` — see §5.                                                                                                                                                                                                   |
| Signing / provisioning                                                                   | Not our code. **Resolve fully before S1** — do not carry it forward.                                                                                                                                                                        |
| `eas.json is not valid` — `"build.*.node" failed custom validation`                      | `node` takes an exact version, never a range. The message appears _after_ the login prompt, so it looks like an auth failure. §5.                                                                                                           |
| `Missing submit profile in eas.json: preview`                                            | `--auto-submit` looks for a submit profile named after the build profile — but `preview` is `distribution: internal` (ad-hoc) and App Store Connect rejects those. Do not add the profile; use `production`. §5.                            |
| An empty `app.json` (`{"expo": {}}`) appears at the **repo root**                        | An eas/expo command was run from the repo root instead of `apps/mobile`. Delete it — a root `app.json` makes Expo tooling treat the whole repo as an app. §5.                                                                               |
| `eas init` cannot save the project id                                                    | `app.config.ts` is dynamic; add `extra.eas.projectId` by hand. §5.                                                                                                                                                                          |
| `expo-doctor` flags the React version                                                    | The workspace override (19.2.7) vs the SDK's React. Unscope the override — §3, not the app.                                                                                                                                                 |
| `pnpm -r typecheck` is green but never entered `mobile`                                  | No `typecheck` script in `apps/mobile/package.json`; `pnpm -r` skips silently. §6.                                                                                                                                                          |
| `pnpm typecheck` in `apps/mobile` fails before `tsc` runs, naming neither tsc nor eslint | `ERR_PNPM_IGNORED_BUILDS` for `unrs-resolver`. Add it to `allowBuilds` — §6. Do **not** edit it into `allowBuilds` by hand while an install is mid-flight: pnpm appends its own placeholder line and the YAML ends up with a duplicate key. |
| `npx testflight` built the wrong bundle identifier                                       | A stray `APP_VARIANT` in the shell or `apps/mobile/.env`. Unset means production by design — D7.                                                                                                                                            |
| Expo UI renders nothing, or a zero-height box                                            | `Host` needs explicit dimensions or `matchContents` — D3.                                                                                                                                                                                   |
| A list stops scrolling (later, at S6)                                                    | `matchContents` on the same axis as a SwiftUI scroll container → `.fixedSize`. Silent by nature — D3.                                                                                                                                       |
| (S2) Auth0 returns and no app opens                                                      | Two variants sharing one URL scheme; iOS picks undefined. Per-variant schemes — D7.                                                                                                                                                         |

---

## 9. What S0 hands to S1

Record these here when the gate goes green; S1's research file starts by reading them.

- [ ] **D8 is decided: SDK 57.** Record the SDK, RN and React versions _actually installed_ and the
      device's iOS version. Two peer facts S1 inherits and must act on before its gate (both in §2):
      **(a)** `@config-plugins/react-native-webrtc` has no SDK 57 release (`expo: ^56`) — check for a
      16.x on the day S1 starts; **(b)** `@elevenlabs/react-native` peers webrtc `^137` while
      `@livekit/react-native ≥ 2.10` requires `^144`, so S1 installs
      `@livekit/react-native@2.9.x` + `@livekit/react-native-webrtc@137.x` + `livekit-client@^2.15.4`
      rather than whatever `npx expo install` offers.
      **Both closed 2026-08-13 in [S1 §2 D10](./2026-08-13-expo-s1-background-audio.md#d10--the-dependency-set-and-the-real-reason-for-it-):**
      (a) is a non-issue; (b) is real but for a different reason, and the correct pin is
      `livekit-client@2.16.1` **exactly** — see the callout in §2 D8.
- [x] **Installed: Expo SDK 57.0.12, RN 0.86.2, React 19.2.3.** `expo-doctor` reports 20/20 with no
      React complaint — the template writes 19.2.3 itself, so §3's pin and the SDK agree exactly.
      TypeScript in `apps/mobile` is **~6.0.3**, a major ahead of the 5.7.2 used by `apps/web` and
      `packages/shared`; independent trees, so it typechecks green, but a syntax feature that only
      TS 6 accepts would compile in mobile and fail in shared. **Device iOS: 26.4** — far above the
      16.4 deployment floor, so nothing in S1 will be gated by OS version on this handset. Keep in
      mind it is also the _only_ device tested; iOS 16.4–18 behaviour is unobserved.
- [x] **EAS project id `6a38b3eb-8751-43eb-bb09-860d58ec4a68`**, in `extra.eas.projectId` in
      `app.config.ts` (by hand — a dynamic config cannot be written by `eas init`, §5). All three
      variants read the same id; `eas config --profile <name>` confirms each one resolves its own
      bundle identifier from it.
- [ ] The three bundle identifiers and their schemes (D7 table) — **S2 needs all three callback URLs**,
      comma-separated in the one Auth0 Native application:
      `englishtutordev://{domain}/ios/work.kovalchuk.yurii.english-tutor-dev/callback`,
      `englishtutorpreview://…-preview/callback`, `englishtutor://…english-tutor/callback`
- [x] **`unstable_enablePackageExports` was NOT needed, and there is no `metro.config.js` at all** —
      SDK 57's template generates none. `npx expo export --platform ios` bundles 1230 modules and the
      Hermes output contains the `KICKOFF_MESSAGE` literal, so subpath exports and raw-TS
      transpilation from outside the app dir both work untouched. The S4/S5/S6 baseline is the clean
      one.
- [ ] The final `eas.json` — S1 needs `EXPO_PUBLIC_AGENT_ID` delivered as an **EAS environment
      variable**, since `.env` is gitignored and never reaches a cloud build. It also needs the
      **development** profile to actually build for the first time, which S0 never exercised.
- [x] Measured turnaround: **an internal (preview) build is 5 minutes** queue-to-artifact, then
      direct install — no Apple processing in that path. The TestFlight path adds a store-signed
      upload plus 5–30 minutes of App Store Connect processing and is **not measured — deferred to S7
      by D9**. S1b's five tests each need an install, so the 5-minute internal loop is the number that
      matters, and under D9 it is the _only_ loop S1–S6 use.
- [ ] The confirmed local release-build command
      (`npx expo prebuild --clean && npx expo run:ios --device --configuration Release`, i.e.
      `pnpm native` + `pnpm device:release`) — untested so far, since the device install came from a
      cloud preview build. Note that it obeys `APP_VARIANT`, so it produces the `-dev` identity
      unless told otherwise. Under D9 the S1 gate runs on `preview` rather than TestFlight.
- [x] **D3 (Expo UI): `@expo/ui@~57.0.10` came from the template**, no install needed. The `Host`
      renders with `style={{ flex: 1 }}` — no `matchContents` and no sizing workaround. **S6 must
      know:** SwiftUI components take no style props; `Text` has no `size`/`weight`/`color`, and
      everything goes through `modifiers={[font({…}), foregroundStyle({…})]}` imported from
      `@expo/ui/swift-ui/modifiers`. `tsc` catches misuse, so this is a compile-time cost, not a
      runtime surprise.
- [x] **The `Host` renders correctly on a real device** (preview build, iOS 26.4) with
      `style={{ flex: 1 }}` and no sizing workaround. SwiftUI text, layout and the shared string all
      appear as written, so S6 starts from a working baseline rather than an assumption.

---

## Sources

- [Expo — Work with monorepos](https://docs.expo.dev/guides/monorepos/) — `nodeLinker: hoisted` for
  pnpm; the pre-SDK-52 `watchFolders` config shown as **no longer needed**.
- [Expo — `eas.json` reference](https://docs.expo.dev/eas/json/) and
  [app versions](https://docs.expo.dev/build-reference/app-versions/) — `node`, `corepack`,
  `appVersionSource`, `autoIncrement`, `submit.ios.ascAppId`.
- [Expo — `npx testflight`](https://docs.expo.dev/build-reference/npx-testflight/) — one-command first
  build + submit; requires a paid Apple Developer account; reuses an existing project's slug.
- [Expo — multiple app variants](https://docs.expo.dev/tutorial/eas/multiple-app-variants/) — the
  `APP_VARIANT` + `app.config.ts` pattern and the `env` field per build profile (D7).
- [Expo SDK 57 changelog](https://expo.dev/changelog/sdk-57) (2026-06-30 — RN 0.86, React 19.2.3,
  "no breaking changes from 0.85") · [Expo SDK 56 changelog](https://expo.dev/changelog/sdk-56)
  (Xcode 26.4, iOS 16.4 floor) · [Expo SDK reference](https://docs.expo.dev/versions/latest/)
  (Node ≥ 22.13 for SDK 57) — the basis for D8.
- [Expo UI is now stable](https://expo.dev/blog/expo-ui-stable-sdk-56) — SwiftUI/Compose stable in
  SDK 56, web experimental, shipped in the default template ·
  [`@expo/ui` reference](https://docs.expo.dev/versions/latest/sdk/ui/) and
  [SwiftUI `Host`](https://docs.expo.dev/versions/latest/sdk/ui/swift-ui/host/) — sizing,
  `matchContents`, and the scroll-container warning (D3).
- [Metro — Package Exports](https://metrobundler.dev/docs/package-exports/) ·
  [expo/expo#26926](https://github.com/expo/expo/issues/26926) — subpath exports from a workspace
  package; `unstable_enablePackageExports` as the escape hatch.
- [eas-cli#2978](https://github.com/expo/eas-cli/issues/2978) — package-manager misdetection.
- [Apple — App Store Connect export compliance](https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations)
  — `ITSAppUsesNonExemptEncryption`.
- In-repo: `docs/2026-08-12-expo-app-creation.md` §7–§8 · `docs/2026-08-12-expo-build-plan.md` (S0) ·
  `docs/2026-08-09-expo-repo-structure-migration.md` §6.1 (why the linker settings exist) ·
  `pnpm-workspace.yaml` · `packages/shared/package.json` + `tsconfig.json`.
