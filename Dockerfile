# open-editor-backend — production image (multi-stage).
#
# Stage 1 builds (with dev deps); stage 2 is a slim runtime with only prod deps
# and the compiled dist. Runs as a non-root user. Migrations are NOT run at
# image build (no DB there) — run them at deploy time (see DEPLOY.md / the
# compose file's migrate step) before starting.

# ---- build ----
FROM node:22-slim AS build
WORKDIR /app
# Install ALL deps (need dev deps to compile TS).
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Copy prod node_modules + compiled output + the files needed at runtime.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# ─── PERSISTENT STORAGE ─────────────────────────────────────────────────────
# Engine bundles go to DELIVERY_BUNDLE_DIR, a persistent volume in production.
#
# ⚠️ A BUILD-TIME `chown` DOES NOT WORK, and looks like it should. The platform
# mounts the volume OVER this path at RUNTIME, replacing the directory with a
# fresh root-owned one — so anything done here is discarded. That was tried,
# deployed cleanly, and changed nothing: `EACCES: permission denied, mkdir
# '/data/bundles'` persisted because the mount shadowed the fix.
#
# Ownership must therefore be fixed AFTER the mount exists — i.e. at container
# start — which is what docker-entrypoint.sh does before dropping to `node`.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# NOTE: deliberately NO `USER node` here. The entrypoint starts as root purely
# to mkdir+chown the mounted volume, then drops to `node` via setpriv (which
# execs, so no root process survives and SIGTERM still reaches node directly).
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

EXPOSE 8787
# Container healthcheck hits the public /health readiness probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations run first, then the server — see migrate-then-start.ts. railway.json
# sets the same command; keeping them identical means a `docker run` of this
# image behaves exactly like the deployed service rather than skipping
# migrations and failing later on a missing table.
CMD ["node", "dist/database/migrate-then-start.js"]
