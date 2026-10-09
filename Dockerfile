# syntax=docker/dockerfile:1

# An explicit image rather than Cloud Buildpacks, for one reason: this app uses
# Node's built-in SQLite, which is only importable without a flag from Node
# 23.4 onwards. Buildpacks resolve the *lowest* version satisfying `engines`,
# so they can hand you a runtime the app cannot boot on. Pinning it here
# removes the guesswork.
# Litestream streams the SQLite database to object storage; see litestream.yml.
# Taken from its official image (published for amd64 and arm64) at a pinned
# version, rather than downloaded during the build.
FROM litestream/litestream:0.5.17 AS litestream

FROM node:24-slim

ENV NODE_ENV=production
# Cloud Run injects PORT (8080). On Fly, fly.toml sets PORT to match
# internal_port. This default only matters if neither does.
ENV PORT=8080

WORKDIR /app

# Dependencies first, so a code-only change does not reinstall them. sharp
# resolves its prebuilt libvips binaries for this platform during install, so
# no build toolchain is needed.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY . .

# Where the database and uploads live when no volume is mounted. A container's
# own filesystem is rebuilt from this image on every deploy and restart, so
# anything stored here is temporary. On Fly, fly.toml mounts a volume at /data
# and points DATA_DIR there. See DEPLOY.md.
#
# start.sh drops from root to the app user with setpriv; checking for it here
# fails the build, rather than the boot, if a base-image change removes it.
RUN mkdir -p /app/data/uploads && chown -R node:node /app/data \
 && chmod +x /app/scripts/start.sh \
 && command -v setpriv \
 && litestream version

# No USER line: the container starts as root only long enough for start.sh to
# hand the mounted volume (root-owned when Fly creates it) to the unprivileged
# `node` user, then everything -- Litestream and the site -- runs as `node`.

EXPOSE 8080

# Cloud Run health-checks the port itself; /healthz is for load balancers and
# uptime checks that want an explicit endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["/app/scripts/start.sh"]
