# syntax=docker/dockerfile:1

# An explicit image rather than Cloud Buildpacks, for one reason: this app uses
# Node's built-in SQLite, which is only importable without a flag from Node
# 23.4 onwards. Buildpacks resolve the *lowest* version satisfying `engines`,
# so they can hand you a runtime the app cannot boot on. Pinning it here
# removes the guesswork.
FROM node:24-slim

ENV NODE_ENV=production
# Cloud Run injects PORT (8080). This default only matters if it does not.
ENV PORT=8080

WORKDIR /app

# Dependencies first, so a code-only change does not reinstall them. sharp
# resolves its prebuilt libvips binaries for this platform during install, so
# no build toolchain is needed.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# The writable data directory. On Cloud Run the container filesystem is
# in-memory and disappears when the instance stops, so this must be pointed at
# a mounted volume (or the database and uploads moved off local disk) before
# anything real is stored here. See DEPLOY.md.
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data/uploads && chown -R node:node /app/data

# Run unprivileged. The image is otherwise read-only to the app.
USER node

EXPOSE 8080

# Cloud Run health-checks the port itself; /healthz is for load balancers and
# uptime checks that want an explicit endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
