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
# Engine bundles are written to DELIVERY_BUNDLE_DIR (a mounted volume in
# production). Platforms mount volumes owned by ROOT, while this image runs as
# the non-root `node` user — so without this the very first write fails with
# EACCES and every bundle publish returns a 500.
#
# Creating the directory here and chowning it means the mount point already
# exists with the right owner when the volume is attached. Proven the hard way:
# a 1-byte upload failed identically to a 600 KB one, which ruled out size and
# pointed straight at permissions.
RUN mkdir -p /data/bundles && chown -R node:node /data
VOLUME ["/data"]

# Run as the built-in non-root `node` user.
USER node

EXPOSE 8787
# Container healthcheck hits the public /health readiness probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
