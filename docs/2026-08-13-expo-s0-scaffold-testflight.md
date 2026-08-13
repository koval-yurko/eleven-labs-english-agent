# S0 — the empty app ships: scaffold, workspace resolution, TestFlight

**Date:** 2026-08-13 · **Status:** researched, not started. **D6, D7, D3 and D8 all decided (§2).** This is the **only** stage research that is
complete — S1–S7 are placeholders by design (see [How the stage docs work](#how-the-stage-docs-work)).

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
| S1    | [`…-expo-s1-background-audio.md`](./2026-08-13-expo-s1-background-audio.md)     | placeholder    |
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

All four are **decided**. D8 was raised and closed on 2026-08-13 against the published peer ranges;
nothing in this file is still open.

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
release the day S1 starts.

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
- [ ] `pnpm why react` from each app directory → exactly one version, 19.2.3, in each.
- [ ] `npx expo-doctor` from `apps/mobile` — this, not `pnpm why`, is what knows the SDK's
      expectations. It should report no React version mismatch.
- [ ] `pnpm dev` / `pnpm build` for web still pass after the downgrade.
- [ ] `pnpm config get node-linker` → `hoisted` (the pnpm-9-fails-silently check from `CLAUDE.md`).
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
  "cli": { "version": ">= 0.34.0", "appVersionSource": "remote" },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal",
      "node": "22.x",
      "env": { "APP_VARIANT": "development" }, // → work.kovalchuk.yurii.english-tutor-dev
    },
    "preview": {
      "distribution": "internal",
      "node": "22.x",
      "env": { "APP_VARIANT": "preview" }, // → …english-tutor-preview
    },
    "production": {
      "distribution": "store",
      "node": "22.x",
      "autoIncrement": true,
      // no APP_VARIANT — unset means production (D7)
    },
  },
  "submit": {
    "production": { "ios": { "appleId": "…", "ascAppId": "…", "appleTeamId": "…" } },
  },
}
```

- **`env.APP_VARIANT`** is what makes D7's three identities real on EAS. `.env` is gitignored and
  never reaches a cloud build, so the profile is the only place the variant can come from — and the
  production profile asserts the default by saying nothing.
- **`node`** pins the build image's Node to match the root `engines: >= 22` (SDK 57 needs ≥ 22.13;
  `22.x` resolves above that). Leaving it to the image
  default is how you get a build that works locally and fails in the cloud.
- **`appVersionSource` + `autoIncrement`** — set one of them explicitly. Without it the _second_
  upload is rejected for a duplicate `ios.buildNumber`, which reads like a signing failure and is not.
- **Package manager.** eas-cli infers pnpm from the root `pnpm-lock.yaml`. If it misdetects
  ([eas-cli#2978](https://github.com/expo/eas-cli/issues/2978)), pin it in the build profile —
  `"corepack": true` (root `packageManager` is already `pnpm@11.20.0`) or an explicit `"pnpm"`
  version field.

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
- **Processing takes 5–30 minutes** after upload. Internal testing groups need no Beta App Review;
  external ones do. Stay internal for S0–S3.

---

## 6. Steps

- [ ] `cd apps && npx create-expo-app@latest mobile --template default` — SDK **57** (D8); `@latest`
      is correct, no `@sdk-xx` pin
- [ ] `"name": "mobile"` in `apps/mobile/package.json` — the root `pnpm mobile` script filters on it
- [ ] **Add `"typecheck": "tsc --noEmit"` and `"lint": "eslint ."`** to `apps/mobile/package.json`.
      The root scripts are `pnpm -r typecheck` / `pnpm -r lint`: a package without the script is
      **skipped silently**, so without this the §7 gate line passes without ever entering mobile
- [ ] Strip the template to a single screen (look for the `reset-project` script first)
- [ ] `pnpm add @tutor/shared@workspace:*` in `apps/mobile`
- [ ] `npx expo install @expo/ui` — check whether the default template already added it (D3)
- [ ] Replace `app.json` with the `app.config.ts` from §2 (D7): three variants, `slug`
      `english-tutor`, `ITSAppUsesNonExemptEncryption: false`
- [ ] `APP_VARIANT=development` in `apps/mobile/.env` for local runs (gitignored, and that is fine —
      §5)
- [ ] Ship the generated `metro.config.js` **untouched**
- [ ] Render `KICKOFF_MESSAGE` from `@tutor/shared/tutor` (§4) **inside an Expo UI `Host`** — one
      `Text` or `Button` from `@expo/ui/swift-ui`, sized with `style={{ flex: 1 }}` (D3)
- [ ] `pnpm install` at the repo root → `ls apps/mobile/node_modules` is a flat tree
- [ ] `npx expo-doctor` from `apps/mobile`; `pnpm why react` per app → **19.2.3**, already pinned (§3)
- [ ] `pnpm typecheck` and `pnpm lint` from the root — confirm the output **names `mobile`**
- [ ] Commit `apps/mobile` (EAS uploads via git — §5)
- [ ] `npx testflight` with no `APP_VARIANT` set, or `eas init` → `eas build --profile production` →
      `eas submit`
- [ ] Install from TestFlight on the target device

**Do not add in this stage:** ElevenLabs, LiveKit, Auth0 (and its plugin/`customScheme` wiring),
`UIBackgroundModes`, `NSMicrophoneUsageDescription`, any `/api/v2/*` route. Each belongs to the stage
whose gate tests it. The development and preview **builds** are also not needed at S0 — the profiles
exist in `eas.json`, but only production is exercised here.

---

## 7. Gate

- [ ] Installs from TestFlight and launches
- [ ] **Displays the string imported from `@tutor/shared/tutor`**
- [ ] **An Expo UI component renders inside a `Host`** (D3 — proves the native module links in a
      cloud build, five stages before S6 depends on it)
- [ ] The installed app is `work.kovalchuk.yurii.english-tutor`, named **English Tutor** — the
      production identity, not a variant (D7)
- [ ] Root `pnpm typecheck` + `pnpm lint` pass **and the output shows `mobile`**, not just `web` and
      `@tutor/shared`
- [ ] A second build uploads without a version collision (proves `autoIncrement`)

The second and third lines are the load-bearing ones. Ten minutes to fix here; a bewildering
afternoon at S4 or S6, where the same failures surface far from their cause.

---

## 8. If it fails

| Symptom                                                  | Cause / next move                                                                                                       |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `Unable to resolve module @tutor/shared/tutor`           | Package exports. Set `config.resolver.unstable_enablePackageExports = true` — the one permitted `metro.config.js` edit. |
| `SyntaxError: Unexpected token` inside `packages/shared` | Metro is not transpiling outside the app dir. Do **not** hand-write `watchFolders`; check the SDK version first.        |
| Resolution works, editor is red                          | tsc, not Metro. Check `moduleResolution: "bundler"` in `apps/mobile/tsconfig.json` before adding `paths`.               |
| Two Reacts at runtime (`Invalid hook call`)              | The override lost. `pnpm why react`; fix the override rather than the app.                                              |
| EAS picks the wrong package manager                      | [eas-cli#2978](https://github.com/expo/eas-cli/issues/2978) — pin `corepack`/`pnpm` in the build profile.               |
| Build fails only in the cloud                            | Node version drift. Pin `"node": "22.x"` per profile.                                                                   |
| Second upload rejected, duplicate build number           | `appVersionSource` / `autoIncrement` not set.                                                                           |
| Build stuck at "Missing Compliance"                      | `ITSAppUsesNonExemptEncryption` — see §5.                                                                               |
| Signing / provisioning                                   | Not our code. **Resolve fully before S1** — do not carry it forward.                                                    |
| `expo-doctor` flags the React version                    | The workspace override (19.2.7) vs the SDK's React. Unscope the override — §3, not the app.                             |
| `pnpm -r typecheck` is green but never entered `mobile`  | No `typecheck` script in `apps/mobile/package.json`; `pnpm -r` skips silently. §6.                                      |
| `npx testflight` built the wrong bundle identifier       | A stray `APP_VARIANT` in the shell or `apps/mobile/.env`. Unset means production by design — D7.                        |
| Expo UI renders nothing, or a zero-height box            | `Host` needs explicit dimensions or `matchContents` — D3.                                                               |
| A list stops scrolling (later, at S6)                    | `matchContents` on the same axis as a SwiftUI scroll container → `.fixedSize`. Silent by nature — D3.                   |
| (S2) Auth0 returns and no app opens                      | Two variants sharing one URL scheme; iOS picks undefined. Per-variant schemes — D7.                                     |

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
- [ ] Confirmation that mobile accepted 19.2.3 without an `expo-doctor` complaint (web was already
      re-verified on the downgrade, 2026-08-13)
- [ ] EAS project id for **English Tutor**, and confirmation that all three variants share it
- [ ] The three bundle identifiers and their schemes (D7 table) — **S2 needs all three callback URLs**,
      comma-separated in the one Auth0 Native application:
      `englishtutordev://{domain}/ios/work.kovalchuk.yurii.english-tutor-dev/callback`,
      `englishtutorpreview://…-preview/callback`, `englishtutor://…english-tutor/callback`
- [ ] Whether `unstable_enablePackageExports` was needed (a yes changes the S4/S5/S6 baseline)
- [ ] The final `eas.json` — S1 needs `EXPO_PUBLIC_AGENT_ID` delivered as an **EAS environment
      variable**, since `.env` is gitignored and never reaches a cloud build. It also needs the
      **development** profile to actually build for the first time, which S0 never exercised.
- [ ] Measured turnaround: build → processing → installable. This is the tick rate of every stage
      after it, and S1b's five tests each need a device install.
- [ ] The confirmed local release-build command
      (`npx expo prebuild --clean && npx expo run:ios --device --configuration Release`) — S1 uses it
      for fast iteration, and TestFlight for the gate itself. Both, not either. Note that it obeys
      `APP_VARIANT`, so S1 iterates on `…-dev` while the gate runs on production.
- [ ] **D3 is decided (Expo UI)** — hand S6 whether the `Host` smoke test needed any sizing
      workaround, and whether `@expo/ui` came from the template or had to be installed

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
