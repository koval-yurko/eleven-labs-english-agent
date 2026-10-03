#!/usr/bin/env bash
# The GitHub Actions self-hosted runner that ships the iOS preview build from this Mac.
#
#   actions-runner/runner.sh install <registration-token>   download, verify, register, start at login
#   actions-runner/runner.sh start | stop | restart | status
#   actions-runner/runner.sh logs                            follow the runner's log
#   actions-runner/runner.sh env                             re-snapshot PATH after a toolchain change
#   actions-runner/runner.sh uninstall <removal-token>       unregister and delete everything uncommitted
#
# Everything the runner owns lives in this folder: its binaries, its credentials (.runner,
# .credentials*), the job workspace (_work/) and the logs (_logs/, _diag/) — all gitignored. The
# one file outside it is the LaunchAgent plist in ~/Library/LaunchAgents, because launchd starts
# agents at login only from there; install writes it and uninstall deletes it.
#
# Tokens: github.com/koval-yurko/eleven-labs-english-agent/settings/actions/runners →
# "New self-hosted runner" (install) or the runner's "Remove" button (uninstall). Both expire in
# an hour.
#
# See docs/2026-10-03-remote-triggers-for-local-ios-build.md.
set -euo pipefail

REPO=koval-yurko/eleven-labs-english-agent
RUNNER_NAME=mac-builder
RUNNER_LABELS=ios-builder
RUNNER_VERSION=2.337.0 # first install only — the runner updates itself afterwards
ASSET=actions-runner-osx-arm64-$RUNNER_VERSION.tar.gz

DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(dirname "$DIR")
MOBILE_ENV=$REPO_DIR/apps/mobile/.env
SVC_LABEL=actions.runner.${REPO/\//-}.$RUNNER_NAME # the name svc.sh would have used
PLIST=$HOME/Library/LaunchAgents/$SVC_LABEL.plist
LOG=$DIR/_logs/runner.log
DOMAIN=gui/$(id -u)

die() {
  echo "runner.sh: $*" >&2
  exit 1
}

# ── Commands ─────────────────────────────────────────────────────────────────

cmd_install() {
  local token=${1:-}
  [[ -n $token ]] || die "usage: runner.sh install <registration-token>"
  [[ ! -f $DIR/.runner ]] || die "already registered — run: runner.sh uninstall <removal-token>"
  [[ $(uname -m) == arm64 ]] || die "this downloads the osx-arm64 runner; this Mac is $(uname -m)"
  check_toolchain
  download

  (cd "$DIR" && ./config.sh --unattended --replace \
    --url "https://github.com/$REPO" --token "$token" \
    --name "$RUNNER_NAME" --labels "$RUNNER_LABELS" --work _work)

  cmd_env
  write_plist
  cmd_start
  echo "Registered. $RUNNER_NAME should show as Idle at https://github.com/$REPO/settings/actions/runners"
}

cmd_start() {
  [[ -f $PLIST ]] || die "not installed — run: runner.sh install <registration-token>"
  # svc.sh runs a copy, not bin/runsvc.sh itself: a self-update swaps bin/ under a running script.
  cp "$DIR/bin/runsvc.sh" "$DIR/runsvc.sh"
  launchctl print "$DOMAIN/$SVC_LABEL" &>/dev/null || launchctl bootstrap "$DOMAIN" "$PLIST"
  # RunAtLoad is not enough: launchd can leave a freshly bootstrapped agent pending ("pended
  # nondemand spawn = speculative", runs = 0) until the next login. -p prints the pid; a
  # running agent is left alone.
  launchctl kickstart -p "$DOMAIN/$SVC_LABEL" >/dev/null
  cmd_status
}

cmd_stop() {
  launchctl bootout "$DOMAIN/$SVC_LABEL" 2>/dev/null || true
  echo "stopped"
}

cmd_status() {
  if launchctl print "$DOMAIN/$SVC_LABEL" 2>/dev/null | grep -E '^\s+(state|pid) ='; then
    return
  fi
  echo "not loaded"
}

cmd_logs() {
  mkdir -p "$DIR/_logs"
  touch "$LOG"
  tail -n 50 -f "$LOG"
}

# The service never reads ~/.zshrc. env.sh snapshots the CURRENT shell's PATH into .path, which is
# how jobs find nvm's node and pnpm, Homebrew's fastlane and pod — the same tools a manual
# `pnpm ship:preview` uses. Run this from a normal terminal, then restart.
cmd_env() {
  check_toolchain
  (cd "$DIR" && ./env.sh)
  set_env LANG en_US.UTF-8                                         # CocoaPods aborts on non-UTF-8
  set_env ACTIONS_RUNNER_HOOK_JOB_STARTED "$DIR/hooks/job-started.sh" # the public-repo guard
  set_env TUTOR_MOBILE_ENV "$MOBILE_ENV"                           # copied into each checkout
  echo "PATH for jobs: $(cat "$DIR/.path")"
}

cmd_uninstall() {
  local token=${1:-}
  [[ -n $token ]] || die "usage: runner.sh uninstall <removal-token>"
  cmd_stop
  rm -f "$PLIST"
  (cd "$DIR" && ./config.sh remove --token "$token")
  # Everything in this folder except the committed files is gitignored, so -X removes exactly the
  # runner; -ff descends into the nested clone under _work/.
  git -C "$REPO_DIR" clean -ffdX -- "$DIR"
  echo "uninstalled"
}

# ── Steps ────────────────────────────────────────────────────────────────────

check_toolchain() {
  local tool
  for tool in node pnpm xcodebuild fastlane pod git jq; do
    command -v "$tool" >/dev/null || die "$tool is not on PATH — run this from a normal terminal"
  done
  [[ -f $MOBILE_ENV ]] || die "$MOBILE_ENV is missing — jobs copy it into each checkout"
  grep -q '^DIAWI_TOKEN=.' "$MOBILE_ENV" || die "DIAWI_TOKEN is not set in $MOBILE_ENV"
}

download() {
  local url=https://github.com/actions/runner/releases/download/v$RUNNER_VERSION/$ASSET
  local want got tmp=$DIR/_download
  want=$(curl -fsSL "https://api.github.com/repos/actions/runner/releases/tags/v$RUNNER_VERSION" |
    jq -r --arg name "$ASSET" '.assets[] | select(.name == $name) | .digest')
  [[ $want == sha256:* ]] || die "GitHub publishes no digest for $ASSET"

  mkdir -p "$tmp"
  curl -fL --progress-bar -o "$tmp/$ASSET" "$url"
  got=sha256:$(shasum -a 256 "$tmp/$ASSET" | cut -d' ' -f1)
  [[ $got == "$want" ]] || die "checksum mismatch: got $got, GitHub says $want"

  tar xzf "$tmp/$ASSET" -C "$DIR"
  rm -rf "$tmp"
}

# Replace-or-append KEY=VALUE in the runner's .env, which it loads into every job's environment.
set_env() {
  local file=$DIR/.env
  touch "$file"
  grep -v "^$1=" "$file" >"$file.tmp" || true
  echo "$1=$2" >>"$file.tmp"
  mv "$file.tmp" "$file"
}

# The runner's own template (bin/actions.runner.plist.template) with two changes: logs go to
# _logs/ instead of ~/Library/Logs, and no SessionCreate — a fresh security session would hide
# the unlocked login keychain, which holds the WWDR G3 intermediate signing depends on.
write_plist() {
  mkdir -p "$(dirname "$PLIST")" "$DIR/_logs"
  cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>$SVC_LABEL</string>
    <key>ProgramArguments</key>
    <array>
      <string>$DIR/runsvc.sh</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$LOG</string>
    <key>StandardErrorPath</key>
    <string>$LOG</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>ACTIONS_RUNNER_SVC</key>
      <string>1</string>
    </dict>
    <key>ProcessType</key>
    <string>Interactive</string>
  </dict>
</plist>
EOF
}

# ── Entry point ──────────────────────────────────────────────────────────────

case ${1:-} in
  install) cmd_install "${2:-}" ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_stop && cmd_start ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  env) cmd_env ;;
  uninstall) cmd_uninstall "${2:-}" ;;
  *) sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' && exit 1 ;;
esac
