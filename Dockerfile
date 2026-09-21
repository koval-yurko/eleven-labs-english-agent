# The tutor worker's production image.
#
# **It lives at the repo root, and that is the whole point.** `lk agent create [working-dir]` uploads
# the working directory as a REMOTE build context and builds the image on LiveKit's own
# infrastructure ("load remote build context" in its output). The context has to be the workspace —
# the lockfile and `@tutor/shared` are both above `apps/voice-worker/` — so the working directory is
# the repo root, and a Dockerfile is read from the root of the context it is given:
#
#   lk agent create .          # from the repo root
#
# Building it here instead is possible but worse on an Apple Silicon machine:
#
#   docker build --platform linux/amd64 -t tutor-worker:latest .
#
# Without `--platform` Docker produces arm64, and every native dependency — `@livekit/rtc-ffi-bindings`,
# `@livekit/local-inference`, `@livekit/av` — resolves to its arm64 build, giving an image that runs
# perfectly on the laptop and cannot run on LiveKit Cloud at all. With it, the whole install runs
# under emulation. Letting LiveKit build it removes both problems.
#
# That is the whole reason this file is hand-written rather than the one `lk agent create` generates.
# The CLI's template assumes a standalone project: it copies `pnpm-lock.yaml` from the app directory
# (this repo has one lockfile, at the root) and then installs from it (which would still fail,
# because `@tutor/shared` is a `workspace:*` dependency and is not in that context either). Both
# problems are the same problem — the build context has to be the workspace, not the app.
# See docs/2026-09-20-livekit-spike-task-plan.md, Phase 4.
#
# **There is no compile step, on purpose.** Phase 1 turned on `allowImportingTsExtensions` so the
# worker's source could use explicit `.ts` imports, and TypeScript requires `noEmit` alongside it —
# so `tsc` cannot produce JavaScript here. The alternatives were to rewrite every import for a
# bundler, or to run the TypeScript directly the way every other entry point in this app already
# does. This runs it directly: `tsx` is a dependency either way, the image ships the same source the
# console and the dev worker run, and there is no build output that can drift from it. The cost is
# a few hundred milliseconds of startup, paid once per job dispatch — worth re-measuring if L6's
# dispatch → joined time disappoints, at which point esbuild with the native modules marked external
# is the fallback.

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

# The LiveKit SDK's native Rust core reads the system trust store at runtime, and the slim image
# does not ship one.
RUN apt-get update -qq \
  && apt-get install --no-install-recommends -y ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# pnpm 11+, not 10: `pnpm-workspace.yaml` sets `nodeLinker: hoisted`, and pnpm 9 ignores that key
# silently and produces a symlinked layout (CLAUDE.md).
RUN npm install -g pnpm@11

FROM base AS build
WORKDIR /repo

# Manifests first, so a source-only change does not re-resolve the dependency graph. Every
# workspace member's package.json is copied even though only two are installed: `--frozen-lockfile`
# validates the lockfile against the whole workspace, and a missing member makes it refuse.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/voice-worker/package.json apps/voice-worker/
COPY apps/web/package.json apps/web/
COPY apps/mobile/package.json apps/mobile/

# `voice-worker...` (with the trailing dots) means the worker AND the workspace packages it depends
# on. The filter is NOT enough on its own: under `nodeLinker: hoisted` this still installs the other
# members' dependencies, which measured at 793 MB of Expo and 445 MB of Next.js inside an image whose
# own worker needs 264 MB. They exist only so `--frozen-lockfile` can validate the lockfile against
# the whole workspace, so they are deleted the moment it has.
RUN pnpm install --frozen-lockfile --filter voice-worker... \
  && rm -rf apps/web apps/mobile

# Only the two packages that ship. The root `.dockerignore` keeps node_modules, build output and
# the local `.env` out of the context entirely.
COPY packages/shared packages/shared
COPY apps/voice-worker apps/voice-worker

# Download assets declared by installed plugins during the build, before any lesson starts.
# Do not invoke pnpm after pruning the other workspace apps: its automatic install would
# re-resolve the reduced workspace and replace the frozen dependencies (observed in Cloud).
RUN apps/voice-worker/node_modules/.bin/livekit-agents download-files

FROM base AS runtime

# Non-privileged, per Docker's own guidance.
ARG UID=10001
RUN adduser --disabled-password --gecos "" --home "/repo" --shell "/sbin/nologin" --uid "${UID}" appuser

WORKDIR /repo
COPY --from=build --chown=appuser:appuser /repo /repo
USER appuser

ENV NODE_ENV=production

# `start`, not `dev`: production mode, no hot reload, and it registers under the agent name in
# `livekit-wire.ts`. Secrets arrive through `lk agent update-secrets`, never in this image.
CMD ["node", "--import", "./apps/voice-worker/node_modules/tsx/dist/loader.mjs", "apps/voice-worker/src/agent.ts", "start"]
