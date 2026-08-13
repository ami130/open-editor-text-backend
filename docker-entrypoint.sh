#!/bin/sh
# docker-entrypoint.sh — make the mounted volume writable, then drop privileges.
#
# ─── WHY A RUNTIME STEP AND NOT A DOCKERFILE `chown` ────────────────────────
# A Dockerfile `RUN mkdir -p /data/bundles && chown node:node /data` runs at
# BUILD time. In production the platform then mounts a persistent volume OVER
# that path at RUNTIME, replacing the directory — and the mount is owned by
# root. The build-time chown is therefore discarded, and the first write fails:
#
#     EACCES: permission denied, mkdir '/data/bundles'
#
# That is exactly what happened on Railway: the build-time fix deployed cleanly
# and changed nothing, because the volume shadowed it.
#
# So ownership must be fixed AFTER the mount exists, which means at container
# start, which means as root — and then we immediately drop to `node` so the
# application itself never runs privileged.
#
# ─── WHY IT IS STILL SAFE ───────────────────────────────────────────────────
# Root is used for exactly two syscalls (mkdir, chown) on one directory, then
# abandoned via `setpriv`, which REPLACES the shell process rather than forking
# — so no root process survives, and signals still reach node directly
# (important: a wrapper that forks would break graceful shutdown).
#
# setpriv rather than su-exec/gosu: this image is Debian (node:22-slim), where
# setpriv ships in util-linux already. Installing an extra package for this
# would add an apt layer and a supply-chain dependency for no benefit.
set -e

DATA_DIR="${DELIVERY_BUNDLE_DIR:-/data/bundles}"

# Only meaningful when we are root; if the platform already starts us as an
# unprivileged user, skip silently rather than failing the boot.
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  # -R because a volume restored from a snapshot can contain files owned by a
  # previous uid. Cheap here: this directory holds a handful of bundles.
  chown -R node:node "$DATA_DIR"
fi

# Hand over to the application as `node`. exec replaces this shell, so PID 1
# stays the real process and receives SIGTERM directly.
# Drop privileges using whichever tool this image actually has. Checked at
# runtime rather than assumed: I could not verify the base image's contents
# locally (no Docker here), and guessing wrong would mean the container either
# fails to start or — far worse — runs the application as ROOT silently.
if [ "$(id -u)" = "0" ]; then
  if command -v setpriv >/dev/null 2>&1; then
    exec setpriv --reuid=node --regid=node --init-groups "$@"
  elif command -v gosu >/dev/null 2>&1; then
    exec gosu node "$@"
  elif command -v su-exec >/dev/null 2>&1; then
    exec su-exec node "$@"
  else
    # No privilege-dropping tool available. FAIL rather than continue: running
    # the app as root would work, which is exactly why it must not be the
    # silent fallback — nobody would notice until it mattered.
    echo "[entrypoint] FATAL: no setpriv/gosu/su-exec available to drop root." >&2
    echo "[entrypoint] Refusing to run the application as root." >&2
    exit 1
  fi
fi

exec "$@"
