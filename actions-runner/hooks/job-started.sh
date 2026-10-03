#!/usr/bin/env bash
# Runs on this Mac before every job the runner picks up (ACTIONS_RUNNER_HOOK_JOB_STARTED, set by
# runner.sh in the runner's .env). A non-zero exit fails the job before any of its steps run.
#
# Why it exists: the repo is public. Anyone can fork it and open a pull request whose workflow
# says `runs-on: [self-hosted, ios-builder]`, and a pull request runs the workflow files FROM THE
# PR. GitHub's fork-approval setting is the first gate; this is the one an attacker cannot edit,
# because it runs from this Mac's working copy, not from the job's checkout.
#
# The rule: only ship-preview.yml, as it exists on master, started by an allow-listed account.
# Pull requests (pull_request, pull_request_target) never match. Anything unset fails closed.
set -euo pipefail

REPOSITORY=koval-yurko/eleven-labs-english-agent
WORKFLOW_REF=$REPOSITORY/.github/workflows/ship-preview.yml@refs/heads/master
EVENTS=(push workflow_dispatch repository_dispatch)
ACTORS=(koval-yurko)

deny() {
  echo "::error::job-started hook refused this job — $1"
  exit 1
}

# $1 must equal one of the remaining arguments.
one_of() {
  local value=$1 allowed
  shift
  for allowed in "$@"; do [[ $value == "$allowed" ]] && return 0; done
  return 1
}

echo "repository=${GITHUB_REPOSITORY-}"
echo "event=${GITHUB_EVENT_NAME-}"
echo "ref=${GITHUB_REF-}"
echo "workflow_ref=${GITHUB_WORKFLOW_REF-}"
echo "actor=${GITHUB_ACTOR-} triggering_actor=${GITHUB_TRIGGERING_ACTOR-}"

[[ ${GITHUB_REPOSITORY-} == "$REPOSITORY" ]] || deny "repository is not $REPOSITORY"
one_of "${GITHUB_EVENT_NAME-}" "${EVENTS[@]}" || deny "event ${GITHUB_EVENT_NAME-unset} is not allowed"
[[ ${GITHUB_REF-} == refs/heads/master ]] || deny "ref is not master"
[[ ${GITHUB_WORKFLOW_REF-} == "$WORKFLOW_REF" ]] || deny "workflow is not ship-preview.yml on master"
one_of "${GITHUB_ACTOR-}" "${ACTORS[@]}" || deny "actor ${GITHUB_ACTOR-unset} is not allow-listed"
# A re-run is started by whoever clicks Re-run, which may not be the original actor.
one_of "${GITHUB_TRIGGERING_ACTOR:-${GITHUB_ACTOR-}}" "${ACTORS[@]}" ||
  deny "triggering actor ${GITHUB_TRIGGERING_ACTOR-} is not allow-listed"

echo "job-started hook: allowed"
