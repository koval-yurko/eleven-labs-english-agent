# English Tutor — iOS app

**This is the product.** All feature work happens here; `apps/web` is deprecated as a UI and kept as
the backend the app calls over HTTP (`/api/v2/*`). Anything new — a screen, a flow, an interaction —
is researched and designed for the phone, not ported from a web page.

It exists for **one reason the web app could not satisfy**: iOS revokes the microphone, interrupts
Web Audio and drops the socket the moment Safari leaves the foreground, so a browser voice lesson
dies when the learner locks the screen. A native app with `UIBackgroundModes: ["audio"]` does not.

**Status: the migration is done.** S0–S7 are all built — every screen the web app has, the phone has,
and the three blockers that could have killed the idea (locked-screen audio, Auth0 on device, a
conversation id surviving WebRTC) were answered on real hardware. What remains is **release**, not
migration: the store pipeline has still never run. The ladder and the open release tail are in
[`docs/2026-08-12-expo-build-plan.md`](../../docs/2026-08-12-expo-build-plan.md); each stage has its
own research file (`docs/2026-08-13-expo-s*.md`). Work since then is ordinary feature work —
[design parity](../../docs/2026-08-15-web-design-parity-on-mobile.md) and
[word autocomplete](../../docs/2026-08-15-word-autocomplete-suggestions.md).

## Stack

| Thing        | Version                    | Note                                                            |
| ------------ | -------------------------- | --------------------------------------------------------------- |
| Expo SDK     | 57                         | RN 0.86, React 19.2.3, Node ≥ 22.13, iOS ≥ 16.4, Xcode 26.4     |
| Navigation   | `expo-router`              | file-based, router root is **`src/app/`**                       |
| UI           | `src/ui/`                  | own design system over RN primitives — see Conventions          |
| Voice        | `@elevenlabs/react-native` | LiveKit/WebRTC under it; needs a dev client, not Expo Go        |
| Auth         | `react-native-auth0`       | native SDK; the access token becomes the Bearer for `/api/v2/*` |
| Local store  | `expo-sqlite/kv-store`     | theme choice + the session journal; no second storage dependency |
| Shared logic | `@tutor/shared`            | the same package the web backend uses                           |

## Commands

Everything lives in this package's `package.json`. From `apps/mobile` use the bare name; from the
repo root, prefix with `pnpm --filter mobile`.

### Day to day

| Script            | Runs                                    | For                                              |
| ----------------- | --------------------------------------- | ------------------------------------------------ |
| `pnpm start`      | `expo start`                            | the dev server                                   |
| `pnpm ios`        | `expo run:ios`                          | build and run the dev client on the simulator    |
| `pnpm check`      | typecheck → lint → expo-doctor → bundle | **the one to run before pushing**                |
| `pnpm typecheck`  | `tsc --noEmit`                          |                                                  |
| `pnpm lint`       | `eslint .`                              |                                                  |
| `pnpm check:expo` | `expo-doctor`                           | 20 checks on SDK/dependency/config sanity        |
| `pnpm bundle`     | `expo export --platform ios`            | the cheap stand-in for a cloud build — see below |

**`pnpm bundle` is the check that earns its keep.** It runs the same Metro pipeline as an EAS
build — resolution, transpilation, the lot — in about six seconds, with no device and no Apple
account involved. A bundling failure caught here costs six seconds instead of a twenty-minute cloud
round trip, which is why `pnpm check` ends with it.

### Local native builds

A dev client on a physically connected device. This is the main loop, because Expo Go cannot load the
ElevenLabs and Auth0 native modules.

| Script                | Runs                                            | For                                                                       |
| --------------------- | ----------------------------------------------- | ------------------------------------------------------------------------- |
| `pnpm native`         | `expo prebuild --clean --platform ios`          | regenerate `ios/` from `app.config.ts`                                    |
| `pnpm device`         | `expo run:ios --device`                         | debug build on the connected device                                       |
| `pnpm device:release` | `expo run:ios --device --configuration Release` | **release** build — background audio behaves differently in a debug build |

These obey `.env`, so they install the **`-dev`** identity and never overwrite a TestFlight build.

### Cloud builds

All of these call `eas-cli` through `npx` with `--platform ios`, elided below for width.

| Script                 | Runs                                           | For                                        |
| ---------------------- | ---------------------------------------------- | ------------------------------------------ |
| `pnpm device:register` | `eas device:create`                            | register a device UDID for internal builds |
| `pnpm build:dev`       | `eas build --profile development`              | dev client, internal distribution          |
| `pnpm build:preview`   | `eas build --profile preview`                  | release build, internal distribution       |
| `pnpm build:prod`      | `eas build --profile production`               | store build                                |
| `pnpm submit`          | `eas submit --latest`                          | send the last build to App Store Connect   |
| `pnpm testflight`      | `eas build --profile production --auto-submit` | build and submit in one pass               |

The profile picks the variant — `eas.json` sets `APP_VARIANT` per profile, and `.env` never reaches a
cloud build.

**Only `production` can reach TestFlight**, and that is a property of Apple, not of our config.
`development` and `preview` are `distribution: internal` — ad-hoc signed for direct install on
registered devices, which App Store Connect rejects. So `--auto-submit` belongs to `build:prod`
alone. Pointing it at `preview` fails immediately with `Missing submit profile in eas.json: preview`,
and adding one would only move the failure twenty minutes downstream to Apple. If you ever do want a
second TestFlight track, it needs its own store-distribution profile **and its own App Store Connect
record**, because the `-preview` bundle identifier is a different app.

`npx eas-cli config --platform ios --profile <name>` prints the fully resolved config and build
profile without building anything — the fastest way to check which identity a profile will produce.
It also shows the split that makes the variants safe: eas-cli does **not** read `.env`, so a
production build keeps the production identity even while `.env` says `APP_VARIANT=development`.

Two things about [`eas.json`](./eas.json) before you edit it: `node` takes an **exact** version (a
range like `22.x` fails validation, and the error surfaces after the login prompt so it reads like an
auth problem), and because [`app.config.ts`](./app.config.ts) is a dynamic config, `eas init` cannot
write `extra.eas.projectId` — it is maintained by hand, one id shared by all three variants.

**The very first build is different:** run `npx testflight` once instead. It walks through EAS project
init, bundle-id confirmation, Apple sign-in, credential generation, the build and the upload
interactively. Use the scripts above from the second build onward.

**`eas-cli` is deliberately not a dependency** — the scripts call it through `npx`. `expo-doctor`
fails the project if it is installed locally, which is also why the doctor script is named
`check:expo` rather than `expo-doctor`: a script whose name matches a binary in `node_modules/.bin`
is itself flagged.

### CLI versions

| CLI           | Where it comes from                        | Keep current with               |
| ------------- | ------------------------------------------ | ------------------------------- |
| Expo CLI      | the `expo` package, SDK-matched            | `npx expo install --check`      |
| `expo-doctor` | a devDependency of this package            | normal dependency updates       |
| `eas-cli`     | **global**, or fetched by `npx` if missing | `npm install -g eas-cli@latest` |

There is no separate Expo CLI to install — it ships inside `expo`, so it is always in step with the
SDK. `eas-cli` is the opposite: it versions independently of the SDK and moves fast, and `npx`
prefers whatever is already on your `PATH`. A stale global install therefore keeps being used
silently. `eas.json` pins `cli.version >= 21.0.0` so an out-of-date CLI fails loudly instead.

## The three app variants

One EAS project (**English Tutor**, slug `english-tutor`) with three identities, selected by the
`APP_VARIANT` environment variable in [`app.config.ts`](./app.config.ts):

| `APP_VARIANT` | Bundle identifier                            | Name                    | URL scheme            |
| ------------- | -------------------------------------------- | ----------------------- | --------------------- |
| `development` | `work.kovalchuk.yurii.english-tutor-dev`     | English Tutor (Dev)     | `englishtutordev`     |
| `preview`     | `work.kovalchuk.yurii.english-tutor-preview` | English Tutor (Preview) | `englishtutorpreview` |
| _unset_       | `work.kovalchuk.yurii.english-tutor`         | English Tutor           | `englishtutor`        |

**Unset means production, deliberately** — `npx testflight` and `expo prebuild` set nothing, and a
build that silently ships under a `-dev` identity is the expensive mistake. An unrecognised value is
a hard error, never a fallback.

Local work uses `.env` (`APP_VARIANT=development`), which is gitignored and therefore invisible to
EAS; cloud builds get the variant from `env` in [`eas.json`](./eas.json). Without that `.env` a local
`npx expo run:ios` would install the **production** bundle identifier over your TestFlight build.

The schemes differ per variant on purpose: two apps claiming `englishtutor://` leaves iOS to pick
one, undefined which. Auth0's callback URL embeds both scheme and bundle id, so each variant needs
its own callback registered.

## Layout

```text
src/app/          expo-router routes — this directory IS the navigation tree
src/ui/           the design system: components + tokens. Screens import appearance from here only.
src/lib/          data access + local state (lessons, items, suggestions, session journal, ids)
src/hooks/        cross-screen hooks (event log, suspension probe)
src/api.ts        the one way this app talks to /api/v2/* — token, base URL, Bearer, error envelope
src/env.ts        the per-variant config from app.config.ts, required and never defaulted
src/theme.ts      scheme choice + palette, over @tutor/shared/theme
app.config.ts     dynamic config: the three variants above
eas.json          build profiles; each sets APP_VARIANT
eslint.config.js  eslint-config-expo, flat config
assets/           app icon + splash only
```

`@/*` maps to `./src/*`, `@/assets/*` to `./assets/*`.

## Conventions

- **Import `@tutor/shared` by module, never by relative path**:
  `import { KICKOFF_MESSAGE } from "@tutor/shared/tutor"`. The package is the one place a protocol
  shared with the web app is allowed to live, and **nothing may be copied out of it** — a duplicated
  `KICKOFF_MESSAGE` or `sanitizeTranscript` produces a session that works and a transcript that is
  quietly wrong. See the repo-root [`CLAUDE.md`](../../CLAUDE.md) for what may and may not be added
  there.
- **There is no `metro.config.js`, and you should not create one.** SDK 52+ handles monorepos
  automatically; the `watchFolders` / `extraNodeModules` snippets in older answers cause the bugs
  they claim to fix. Package-exports resolution of `@tutor/shared` subpaths works untouched.
- **Appearance comes from `src/ui`, and from nowhere else.** Screens import components and tokens
  from the `@/ui` barrel; a colour literal, a font size or a radius written inline in a screen is the
  drift that directory exists to end. Colours come from `@tutor/shared/theme` via `useTheme()` —
  that half is shared with the web byte for byte — while geometry is per-platform in `src/ui/tokens.ts`,
  each value carrying the `rem` it was derived from. Need a number that isn't there? Add it there.
  See [`docs/2026-08-15-web-design-parity-on-mobile.md`](../../docs/2026-08-15-web-design-parity-on-mobile.md).
- **`@expo/ui` was removed, deliberately.** The SwiftUI components were the better native design, but
  they take their type scale and colours from the system, which is exactly what made them impossible
  to hold in parity with the shared palette. The trade is recorded in §10.1 of the parity doc; do not
  reintroduce the dependency without reading it.
- **React is pinned workspace-wide to the version React Native requires** (`overrides` in
  `pnpm-workspace.yaml`). Do not pin React in this package's `package.json` — the override wins and
  the declared version becomes decoration.
- **Expo Go will not work**: `@elevenlabs/react-native` and `react-native-auth0` need custom native
  code. The loop is `expo-dev-client` + `npx expo prebuild` + `npx expo run:ios`.
- **Secrets never live here.** Only `EXPO_PUBLIC_*` values reach the app, and they are inlined into
  the bundle exactly like `NEXT_PUBLIC_*` — treat them as public. The ElevenLabs and Supabase
  service-role keys stay on the web server, which is why the token route exists.

## Gotchas

- **EAS uploads via git.** Uncommitted and gitignored files do not reach a cloud build, `.env`
  included. Deliver environment values to cloud builds with `eas env`, not `.env`.
- **`unrs-resolver` must stay in `allowBuilds`** (`pnpm-workspace.yaml`). pnpm 10+ blocks its
  postinstall, and the failure is not a warning: the deps-status check exits non-zero, so
  `pnpm typecheck` here dies before `tsc` runs, with an error naming neither tool.
- **TypeScript here is 6.x**, a major ahead of `apps/web` and `packages/shared` (5.7). Separate
  dependency trees, so both typecheck — but TS 6-only syntax added to `packages/shared` would compile
  in this app and fail everywhere else.
- **`pnpm -r <script>` silently skips a package that has no such script.** That is why `typecheck`
  and `lint` are declared in [`package.json`](./package.json); delete them and the root checks go
  green without ever entering this directory.
- **Two script names are avoided on purpose.** `doctor` would be shadowed by pnpm's own built-in
  `pnpm doctor` — it runs, prints "all checks passed", and never touches Expo. `prebuild` is an
  npm/pnpm lifecycle hook: adding a `build` script later would silently run it first, and
  `expo prebuild --clean` deletes `ios/`. Hence `check:expo` and `native`.
