#!/usr/bin/env bash
#
# install-monitor-cron.sh — run the delivery check every 15 minutes.
#
# WHY: check-delivery.mjs asserts the customer-visible chain and catches the
# failures /health cannot see (empty keyring, licence not resolving to premium,
# a bundle whose digest does not match). It has existed since the last release
# and NOTHING HAS BEEN RUNNING IT — a monitor nobody runs is documentation.
#
# This installs one crontab line. It is idempotent: re-running replaces the
# existing entry rather than adding a duplicate.
#
#   bash scripts/install-monitor-cron.sh                 # install
#   bash scripts/install-monitor-cron.sh --uninstall     # remove
#   bash scripts/install-monitor-cron.sh --dry-run       # show, change nothing
#
# The licence key is read from a file rather than baked into the crontab, so it
# does not sit in `crontab -l` output or in process listings.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEY_FILE="${KEY_FILE:-$HERE/../INTERNAL-DEMO-KEY.txt}"
LOG="${LOG:-$HOME/Library/Logs/oe-delivery.log}"
ORIGIN="${ORIGIN:-https://open-editor-text-web.vercel.app}"
MARKER="# open-editor delivery monitor"

# ⚠️ RESOLVE npm TO AN ABSOLUTE PATH.
#
# cron does NOT load your shell profile. Under nvm (or Homebrew, or asdf) npm
# lives somewhere like ~/.nvm/versions/node/v24.12.0/bin/npm, which is not in
# cron's minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin). A bare `npm` in the
# crontab therefore dies with "env: npm: No such file or directory" — every 15
# minutes, into a log nobody reads, while the monitor appears installed.
#
# Caught by running the entry under `env -i` before trusting it. A monitor that
# silently never runs is worse than no monitor: it manufactures false calm.
NPM_BIN="$(command -v npm || true)"
if [ -z "$NPM_BIN" ]; then
  echo "  ✗ npm not found on PATH — cannot build a cron entry."
  exit 1
fi
# node must also be reachable, since npm shells out to it.
NODE_DIR="$(dirname "$NPM_BIN")"

# The key file has a header; the token is the last non-empty line.
CMD="cd '$HERE' && PATH=\"$NODE_DIR:\$PATH\" LICENCE_KEY=\$(tail -n 2 '$KEY_FILE' | tr -d '[:space:]') ORIGIN='$ORIGIN' '$NPM_BIN' run --silent check:delivery >> '$LOG' 2>&1"
LINE="*/15 * * * * $CMD $MARKER"

case "${1:-}" in
  --uninstall)
    crontab -l 2>/dev/null | grep -v "$MARKER" | crontab - || true
    echo "  removed the delivery monitor from crontab"
    exit 0
    ;;
  --dry-run)
    echo "  would install:"
    echo "    $LINE"
    echo
    echo "  log: $LOG"
    exit 0
    ;;
esac

if [ ! -f "$KEY_FILE" ]; then
  echo "  ✗ No licence key file at $KEY_FILE"
  echo "    Set KEY_FILE=/path/to/key, or run without a key to monitor the"
  echo "    anonymous chain only (premium checks are then skipped)."
  exit 1
fi

mkdir -p "$(dirname "$LOG")"

# Verify it actually passes BEFORE scheduling it. Installing a monitor that is
# already failing means the first alert is about the install, not the service.
echo "  running the check once before scheduling…"
if ! (cd "$HERE" && LICENCE_KEY="$(tail -n 2 "$KEY_FILE" | tr -d '[:space:]')" ORIGIN="$ORIGIN" npm run --silent check:delivery); then
  echo
  echo "  ✗ The check FAILED right now. Not scheduling it — fix the failure first,"
  echo "    or you will schedule an alarm that is already ringing."
  exit 1
fi

# Run the ACTUAL command line in a cron-like environment — no shell profile, no
# inherited PATH. This is what caught npm-under-nvm being invisible to cron; a
# check that only runs in your interactive shell proves nothing about cron.
echo "  verifying the command works in a bare (cron-like) environment…"
if ! env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
     sh -c "${CMD%% >>*}" >/dev/null 2>&1; then
  echo
  echo "  ✗ The command FAILED with cron's minimal environment, even though it"
  echo "    works in your shell. Almost always PATH: cron cannot see a"
  echo "    version-manager npm (nvm/asdf/Homebrew)."
  echo
  echo "    npm resolved to: $NPM_BIN"
  echo "    Not scheduling — a monitor that never runs is worse than none."
  exit 1
fi

( crontab -l 2>/dev/null | grep -v "$MARKER" || true; echo "$LINE" ) | crontab -

echo
echo "  ✓ installed — runs every 15 minutes"
echo "    log:    $LOG"
echo "    view:   crontab -l | grep 'delivery monitor'"
echo "    remove: bash scripts/install-monitor-cron.sh --uninstall"
echo
echo "  ⚠️  cron only runs while this machine is awake. For real coverage, run"
echo "     the same command from an always-on host or an uptime service that"
echo "     can execute a script and alert on a non-zero exit."
