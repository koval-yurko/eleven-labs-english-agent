#!/usr/bin/env bash
# The voice worker on the Mac that runs Voicebox: agent name `tutor-local`, served by launchd.
#
#   services/voice-worker/scripts/local-worker.sh deploy <checkout>   copy, install, switch, restart, wait for registration
#   services/voice-worker/scripts/local-worker.sh start | stop | restart | status
#   services/voice-worker/scripts/local-worker.sh logs                 follow the worker's log
#   services/voice-worker/scripts/local-worker.sh rollback             switch `current` to the previous release
#   services/voice-worker/scripts/local-worker.sh uninstall            stop and remove the LaunchAgent (keeps releases and .env)
#   services/voice-worker/scripts/local-worker.sh run                  what the LaunchAgent runs: the worker, restarted when it exits
#
# The worker never runs from a Git checkout: the runner's _work/ changes under every job, and the
# working copy in ~/dev holds other branches and uncommitted work. `deploy` copies the checkout's
# files (tracked plus untracked-but-not-ignored, so never node_modules or a .env) into
# $TUTOR_WORKER_HOME/releases/<sha>, installs the worker's dependencies there, copies
# $TUTOR_WORKER_HOME/.env in as services/voice-worker/.env, points `current` at it and restarts.
# The last $KEEP releases stay for `rollback`.
#
# The LaunchAgent sets LIVEKIT_AGENT_NAME=tutor-local, so this worker gets only the versions with
# `worker: "local"` (words-4.4) and the LiveKit Cloud worker keeps the rest. `.env` is the same file
# as the Cloud worker's (`pnpm env:push --target worker`); words-4.4 speaks with the
# `voicebox-local` profile, which ignores its tunnel VOICEBOX_URL.
#
# Deployed on every push to master by .github/workflows/deploy-voice-worker-local.yml on the
# self-hosted runner. Voice-Agent project: docs/2026-10-27-local-voice-worker-on-mac-research.md.
set -euo pipefail

AGENT_NAME=tutor-local
LABEL=win.kovalchuk.voice-worker
HOME_DIR=${TUTOR_WORKER_HOME:-$HOME/voice-worker}
RELEASES=$HOME_DIR/releases
CURRENT=$HOME_DIR/current
ENV_FILE=$HOME_DIR/.env
PLIST=$HOME/Library/LaunchAgents/$LABEL.plist
LOG_DIR=$HOME/Library/Logs/voice-worker
LOG=$LOG_DIR/worker.log
DOMAIN=gui/$(id -u)
KEEP=3
REGISTER_TIMEOUT_S=90

die() {
  echo "local-worker.sh: $*" >&2
  exit 1
}

# ── Commands ─────────────────────────────────────────────────────────────────

cmd_deploy() {
  local src=${1:-}
  [[ -n $src && -d $src/.git ]] || die "usage: local-worker.sh deploy <git checkout of the repo>"
  src=$(cd "$src" && pwd)
  [[ -f $ENV_FILE ]] || die "$ENV_FILE is missing — copy services/voice-worker/.env there (chmod 600)"
  command -v node >/dev/null || die "node is not on PATH"
  command -v pnpm >/dev/null || die "pnpm is not on PATH"

  local sha release
  sha=$(git -C "$src" rev-parse --short=12 HEAD)
  [[ -z $(git -C "$src" status --porcelain) ]] || sha=$sha-dirty-$(date +%Y%m%d%H%M%S)
  release=$RELEASES/$sha

  if [[ -d $release ]]; then
    echo "release $sha already exists; reusing it"
  else
    echo "copying $src → $release"
    rm -rf "$release.tmp"
    mkdir -p "$release.tmp"
    # Tracked and untracked-but-not-ignored files that exist (a deleted tracked file is skipped).
    (cd "$src" && git ls-files -co --exclude-standard -z |
      while IFS= read -r -d '' f; do [[ -e $f ]] && printf '%s\0' "$f"; done |
      tar --null -T - -cf -) | tar -xf - -C "$release.tmp"

    echo "installing the worker's dependencies"
    # `voice-worker...` = the worker and the workspace packages it depends on; the store makes
    # this a link step after the first run. CI=true keeps pnpm from asking anything.
    (cd "$release.tmp" && CI=true pnpm install --frozen-lockfile --filter voice-worker... >/dev/null)
    # Assets the plugins declare (the Dockerfile does the same at build time). Called directly, not
    # through pnpm, so pnpm does not re-resolve the filtered install.
    (cd "$release.tmp" && services/voice-worker/node_modules/.bin/livekit-agents download-files >/dev/null)
    mv "$release.tmp" "$release"
  fi

  install -m 600 "$ENV_FILE" "$release/services/voice-worker/.env"
  ln -sfn "$release" "$CURRENT"
  echo "current → $sha"

  write_plist
  restart_and_wait
  prune
}

cmd_start() {
  [[ -f $PLIST ]] || die "not installed — run: local-worker.sh deploy <checkout>"
  launchctl print "$DOMAIN/$LABEL" &>/dev/null || launchctl bootstrap "$DOMAIN" "$PLIST"
  # A freshly bootstrapped agent can stay pending until the next login; -p starts it now.
  launchctl kickstart -p "$DOMAIN/$LABEL" >/dev/null
  cmd_status
}

cmd_stop() {
  bootout_and_wait
  echo "stopped"
}

cmd_status() {
  if [[ -L $CURRENT ]]; then echo "release = $(basename "$(readlink "$CURRENT")")"; fi
  if launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E '^\s+(state|pid|last exit code) ='; then
    grep '"registered worker"' "$LOG" 2>/dev/null | tail -1 | sed -E 's/.*"time":([0-9]+).*"agentName":"([^"]*)".*/last registration: agent \2 at epoch-ms \1/' || true
    return
  fi
  echo "not loaded"
}

cmd_logs() {
  mkdir -p "$LOG_DIR"
  touch "$LOG"
  tail -n 50 -f "$LOG"
}

cmd_rollback() {
  local now previous
  now=$(readlink "$CURRENT" 2>/dev/null) || die "no current release"
  previous=$(ls -1dt "$RELEASES"/*/ 2>/dev/null | sed 's:/$::' | grep -vx "$now" | head -1)
  [[ -n $previous ]] || die "no previous release to roll back to"
  ln -sfn "$previous" "$CURRENT"
  echo "current → $(basename "$previous")"
  restart_and_wait
}

# The LaunchAgent's program. launchd's own KeepAlive did not bring a crashed worker back: after a
# SIGKILL it left the job "pended nondemand spawn = inefficient" and did not start it again (seen
# 2026-10-27), so this loop restarts node itself. On SIGTERM (bootout, deploy) it passes the signal
# to node, waits for it to drain and exits.
cmd_run() {
  local node=${VOICE_WORKER_NODE:?set by the LaunchAgent} child="" code stopping=0
  trap 'stopping=1; [[ -n $child ]] && kill -TERM "$child" 2>/dev/null' TERM INT
  cd "$CURRENT/services/voice-worker"
  while ((stopping == 0)); do
    "$node" --import "$PWD/node_modules/tsx/dist/loader.mjs" src/agent.ts start &
    child=$!
    code=0
    wait "$child" || code=$?
    # A trapped signal interrupts `wait`; wait again for node to finish draining.
    if ((stopping)); then
      wait "$child" 2>/dev/null || true
      break
    fi
    child=""
    echo "[local-worker] worker exited with code $code; restarting in 5 s"
    sleep 5 &
    wait $! || true
  done
}

cmd_uninstall() {
  cmd_stop
  rm -f "$PLIST"
  echo "LaunchAgent removed; $HOME_DIR (releases, .env) kept"
}

# ── Steps ────────────────────────────────────────────────────────────────────

# Rewritten on every deploy with the node that runs the deploy: launchd never loads nvm, and a
# node upgrade should reach the worker with the next deploy rather than leave it on a deleted path.
write_plist() {
  local node worker=$CURRENT/services/voice-worker
  node=$(command -v node)
  mkdir -p "$(dirname "$PLIST")" "$LOG_DIR"
  cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>$worker/scripts/local-worker.sh</string>
      <string>run</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$worker</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>LIVEKIT_AGENT_NAME</key>
      <string>$AGENT_NAME</string>
      <key>VOICE_WORKER_NODE</key>
      <string>$node</string>
      <key>TUTOR_WORKER_HOME</key>
      <string>$HOME_DIR</string>
      <key>NODE_ENV</key>
      <string>production</string>
      <key>PATH</key>
      <string>$(dirname "$node"):/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ExitTimeOut</key>
    <integer>60</integer>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>StandardOutPath</key>
    <string>$LOG</string>
    <key>StandardErrorPath</key>
    <string>$LOG</string>
  </dict>
</plist>
EOF
}

# bootout + bootstrap, not just kickstart -k: the plist may have changed (node path).
restart_and_wait() {
  local offset waited=0
  mkdir -p "$LOG_DIR"
  touch "$LOG"
  offset=$(wc -c <"$LOG")
  bootout_and_wait
  launchctl bootstrap "$DOMAIN" "$PLIST"
  launchctl kickstart -p "$DOMAIN/$LABEL" >/dev/null
  echo "waiting for the worker to register as $AGENT_NAME"
  # pino JSON: "agentName" comes before "msg" on the line, so match the two separately.
  until tail -c +"$((offset + 1))" "$LOG" | grep '"registered worker"' | grep -q "\"agentName\":\"$AGENT_NAME\""; do
    ((waited += 2))
    if ((waited > REGISTER_TIMEOUT_S)); then
      tail -c +"$((offset + 1))" "$LOG" | tail -n 30 >&2
      die "no registration within ${REGISTER_TIMEOUT_S}s — see $LOG"
    fi
    sleep 2
  done
  echo "registered as $AGENT_NAME after ~${waited}s"
}

# `bootout` returns while the old worker still drains (state "SIGTERMed"); a bootstrap in that window
# fails with "Bootstrap failed: 5: Input/output error" (seen 2026-10-27). Wait until launchd has
# dropped the job — at most ExitTimeOut (60 s), after which launchd kills it.
bootout_and_wait() {
  local waited=0
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  while launchctl print "$DOMAIN/$LABEL" &>/dev/null; do
    ((waited += 1))
    ((waited <= 70)) || die "launchd still holds $LABEL after 70 s"
    sleep 1
  done
}

prune() {
  local keep_current
  keep_current=$(readlink "$CURRENT")
  ls -1dt "$RELEASES"/*/ 2>/dev/null | sed 's:/$::' | grep -vx "$keep_current" | tail -n +"$KEEP" |
    while IFS= read -r old; do
      echo "removing old release $(basename "$old")"
      rm -rf "$old"
    done
  rm -rf "$RELEASES"/*.tmp
}

# ── Entry point ──────────────────────────────────────────────────────────────

case ${1:-} in
  deploy) cmd_deploy "${2:-}" ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) [[ -f $PLIST ]] || die "not installed"; restart_and_wait ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  rollback) cmd_rollback ;;
  run) cmd_run ;;
  uninstall) cmd_uninstall ;;
  *) sed -n '4,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' && exit 1 ;;
esac
