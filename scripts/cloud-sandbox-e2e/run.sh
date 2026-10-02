#!/usr/bin/env bash
# Runs the cloud sandbox e2e (e2e.mjs) against a cs-e2e build: downloads the .deb of the fork prerelease
# cs-<sha8> (cs-e2e-build.yml), checks its sha256, extracts it WITHOUT installing (the machine's own Pane is
# never touched), and runs the driver under xvfb with a fresh isolated profile.
#
#   scripts/cloud-sandbox-e2e/run.sh <tag> [work dir]        e.g. run.sh cs-7c438bd8
#   MODE=fake|live (default fake)  PHASES=add,agent,...  OUT=<evidence dir>  KEEP=1 (keep an existing work dir)
#   KEEP_CREDENTIALS=1  don't shred the staged credentials at the end (a run split over invocations)
#
# Live runs also pass the .deb's URL and sha256 to the app (RUNPANE_CLOUD_PANE_DEB_URL/_SHA256), so the
# sandbox installs the same build. Needs node, xvfb-run, dpkg-deb, gh, unzip, and playwright-core in
# $PLAYWRIGHT_DIR (default ~/.cache/cs-e2e).
set -euo pipefail
tag="${1:?usage: run.sh <cs-tag> [work dir]}"
repo="${REPO:-jamari-morrison/Pane}"
here="$(cd "$(dirname "$0")" && pwd)"
cache="${CACHE_DIR:-$HOME/.cache/cs-e2e}"
work="${2:-$cache/runs/$tag-${MODE:-fake}-$(date -u +%Y%m%dT%H%M%SZ)}"
build="$cache/builds/$tag"

# The release's current sums decide; a cached build whose .deb no longer matches them is fetched again.
mkdir -p "$build/download"
gh release download "$tag" --repo "$repo" --dir "$build" --pattern SHA256SUMS.txt --clobber
if ! cmp -s "$build/SHA256SUMS.txt" "$build/download/SHA256SUMS.txt"; then rm -rf "$build/opt" "$build/usr" "$build/download"/*; fi
if [ ! -x "$build/opt/Pane/pane" ]; then
  mkdir -p "$build/download"
  gh release download "$tag" --repo "$repo" --dir "$build/download" --pattern '*.deb' --pattern SHA256SUMS.txt --clobber
  (cd "$build/download" && sha256sum -c SHA256SUMS.txt)
  dpkg-deb -x "$build/download"/*.deb "$build"
fi
deb="$(basename "$(ls "$build/download"/*.deb)")"
export PANE_DEB_URL="https://github.com/$repo/releases/download/$tag/$deb"
PANE_DEB_SHA256="$(cut -d' ' -f1 "$build/download/SHA256SUMS.txt")"
export PANE_DEB_SHA256

if [ -d "$work" ] && [ "${KEEP:-0}" != 1 ]; then echo "work dir $work exists (KEEP=1 to reuse it)" >&2; exit 2; fi
mkdir -p "$work"
export WORK="$work" OUT="${OUT:-$work/evidence}" PANE_BIN="$build/opt/Pane/pane" MODE="${MODE:-fake}"
export NODE_PATH="${PLAYWRIGHT_DIR:-$cache}/node_modules"
# playwright-core is resolved from the driver's directory; link the cached copy next to it for the run.
ln -sfn "$NODE_PATH" "$here/node_modules"
# Every run ends by shredding what the app saved from the credentials it was given (the library's
# credentials, host records and settings) and the profile's saved host tokens. KEEP_CREDENTIALS=1 keeps them
# for a run split over several invocations (KEEP=1 PHASES=...); its last invocation must leave it unset.
cleanup() {
  rm -f "$here/node_modules"
  if [ "${KEEP_CREDENTIALS:-0}" != 1 ]; then
    find "$work/home/.config/runpane-cloud" "$work/home/.pane/config.json" -type f -exec shred -u {} + 2>/dev/null || true
    echo "shredded staged credentials and saved host tokens under $work/home"
  fi
}
trap cleanup EXIT
echo "build $tag ($deb), work $work, mode $MODE"
xvfb-run -a -s "-screen 0 1440x900x24" node "$here/e2e.mjs"
