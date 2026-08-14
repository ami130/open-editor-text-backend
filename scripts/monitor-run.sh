#!/usr/bin/env bash
#
# monitor-run.sh — run the delivery check, and ACTUALLY TELL SOMEONE if it fails.
#
# ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
# The cron entry used to be `check:delivery >> logfile 2>&1`. That is detection
# without notification: if delivery breaks at 3am, the failure lands in a file
# nobody reads and you find out the same way as before — by clicking. Calling
# that "monitoring" was generous.
#
# This wraps the check and, on failure, raises a macOS notification AND writes a
# loud marker to the log. Optionally POSTs to a webhook (Slack/Discord/anything)
# so alerting survives the laptop being asleep.
#
# It also solves two smaller problems the raw cron line had:
#   • the log grew unbounded (~96 runs/day, forever)
#   • a PASS and a FAIL looked identical when skimming
#
# ─── USAGE ──────────────────────────────────────────────────────────────────
#   bash scripts/monitor-run.sh
#
# Env:
#   LICENCE_KEY      premium chain is skipped without it
#   ALERT_WEBHOOK    optional; POSTed a JSON {text: …} on failure
#   LOG              default ~/Library/Logs/oe-delivery.log
#   MAX_LOG_BYTES    default 1 MiB, rotated to .1
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="${LOG:-$HOME/Library/Logs/oe-delivery.log}"
MAX_LOG_BYTES="${MAX_LOG_BYTES:-1048576}"
STAMP="$(date '+%Y-%m-%d %H:%M:%S')"

mkdir -p "$(dirname "$LOG")"

# Rotate BEFORE writing, so an unattended monitor cannot fill the disk.
if [ -f "$LOG" ]; then
  SIZE=$(wc -c < "$LOG" | tr -d ' ')
  [ "$SIZE" -gt "$MAX_LOG_BYTES" ] && mv -f "$LOG" "$LOG.1"
fi

OUT="$(cd "$HERE" && npm run --silent check:delivery 2>&1)"
CODE=$?

if [ $CODE -eq 0 ]; then
  # One line on success. The detail is only interesting when something breaks,
  # and a quiet log makes a failure stand out instead of hiding in the noise.
  echo "$STAMP  OK" >> "$LOG"
  exit 0
fi

# ── FAILURE ────────────────────────────────────────────────────────────────
{
  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo "$STAMP  DELIVERY CHECK FAILED (exit $CODE)"
  echo "════════════════════════════════════════════════════════════"
  echo "$OUT"
  echo ""
} >> "$LOG"

# What actually failed, for a one-line alert body.
SUMMARY="$(echo "$OUT" | grep '✗' | head -3 | sed 's/^ *//' | tr '\n' ';' | cut -c1-200)"
[ -z "$SUMMARY" ] && SUMMARY="check exited $CODE"

# macOS notification — free, native, no install. Best-effort: a headless or
# non-macOS host simply has no osascript, and that must not fail the run.
if command -v osascript >/dev/null 2>&1; then
  osascript -e "display notification \"${SUMMARY//\"/\'}\" with title \"Open Editor: delivery FAILING\" sound name \"Basso\"" >/dev/null 2>&1 || true
fi

# Webhook — the only channel that works while this machine is asleep.
if [ -n "${ALERT_WEBHOOK:-}" ]; then
  curl -s -m 15 -X POST "$ALERT_WEBHOOK" \
    -H 'Content-Type: application/json' \
    -d "{\"text\":\"🔴 Open Editor delivery FAILING — ${SUMMARY//\"/\'}\"}" >/dev/null 2>&1 || true
fi

exit $CODE
