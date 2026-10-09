#!/bin/sh
# Container entry point.
#
#   scripts/start.sh                 start the site (what the Dockerfile runs)
#   scripts/start.sh npm run seed    run a one-off command the same way the site
#                                    runs: as the app user, against the same data
#
# The second form is for `fly ssh console`, which logs in as root. Running a
# command like the seed as root would leave root-owned files on the volume that
# the site, running unprivileged, then cannot write to:
#
#   fly ssh console -C "/app/scripts/start.sh npm run seed"
set -eu

APP_USER=node

# Fly volumes mount at /data. Elsewhere (local Docker, tests) fall back to the
# image's own directory.
if [ -z "${DATA_DIR:-}" ]; then
  if [ -d /data ]; then DATA_DIR=/data; else DATA_DIR=/app/data; fi
fi
export DATA_DIR
export DB_FILE="${DB_FILE:-$DATA_DIR/eaa1699.sqlite}"

# --- as root: hand the volume to the app user, then drop privileges ----------
# A freshly created Fly volume is owned by root. The site deliberately runs as
# an unprivileged user, so without this it boots fine and then fails on the
# first write. chown -R also repairs anything a root shell left behind.
if [ "$(id -u)" = 0 ]; then
  mkdir -p "$DATA_DIR/uploads"
  chown -R "$APP_USER:$APP_USER" "$DATA_DIR"
  export HOME="/home/$APP_USER"
  exec setpriv --reuid="$APP_USER" --regid="$APP_USER" --init-groups "$0" "$@"
fi

# --- where backups go ---------------------------------------------------------
# `fly storage create` attaches a Tigris bucket and sets BUCKET_NAME plus the
# AWS_* credentials as secrets. LITESTREAM_REPLICA_URL can be set instead, to
# use some other S3-compatible store.
if [ -z "${LITESTREAM_REPLICA_URL:-}" ] && [ -n "${BUCKET_NAME:-}" ]; then
  LITESTREAM_REPLICA_URL="s3://${BUCKET_NAME}/eaa1699.sqlite?endpoint=fly.storage.tigris.dev&region=auto"
fi
if [ -n "${LITESTREAM_REPLICA_URL:-}" ]; then
  export LITESTREAM_REPLICA_URL
fi
LITESTREAM_CONFIG="${LITESTREAM_CONFIG:-/app/litestream.yml}"
export LITESTREAM_CONFIG

# --- a one-off command ----------------------------------------------------------
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

# --- the site -------------------------------------------------------------------
if [ -z "${LITESTREAM_REPLICA_URL:-}" ]; then
  echo "[start] WARNING: no backup configured (no Tigris bucket attached)." >&2
  echo "[start] The database is NOT being backed up. See DEPLOY.md, Fly.io." >&2
  exec node server.js
fi

# Rolling back. If an earlier copy has been restored to restore.sqlite (see
# DEPLOY.md, "Restoring"), put it live now, while nothing has the database
# open. The database it replaces is kept beside it, renamed, in case the
# rollback itself turns out to be the mistake. Litestream carries on from the
# swapped-in copy, so the backup follows the rollback.
RESTORE_FILE="$DATA_DIR/restore.sqlite"
if [ -f "$RESTORE_FILE" ]; then
  STAMP=$(date -u +%Y%m%dT%H%M%SZ)
  for suffix in "" -wal -shm; do
    if [ -e "$DB_FILE$suffix" ]; then mv "$DB_FILE$suffix" "$DB_FILE.before-restore-$STAMP$suffix"; fi
  done
  # A -wal beside the restored copy (opening it to inspect makes one) holds
  # pages that belong to it, so it moves too.
  for suffix in "" -wal -shm; do
    if [ -e "$RESTORE_FILE$suffix" ]; then mv "$RESTORE_FILE$suffix" "$DB_FILE$suffix"; fi
  done
  echo "[start] Rolled back: restore.sqlite is now the live database." >&2
  echo "[start] The one it replaced is $DB_FILE.before-restore-$STAMP" >&2
fi

# If the volume has no database -- a new volume, or a replacement after losing
# the old one -- bring the latest copy back from the backup before starting.
# Both flags make this a no-op in the ordinary case: a database already present
# is never overwritten, and an empty bucket (first ever boot) is not an error.
litestream restore -config "$LITESTREAM_CONFIG" -if-db-not-exists -if-replica-exists "$DB_FILE"

# Litestream runs the site as its child, streams every change to the bucket,
# and on shutdown stops the site first and then makes a final sync.
exec litestream replicate -config "$LITESTREAM_CONFIG" -exec "node server.js"
