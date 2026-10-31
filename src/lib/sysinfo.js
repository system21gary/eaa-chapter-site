import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import config from '../config.js';
import { get } from '../db/index.js';
import { TZ } from './localtime.js';

const require = createRequire(import.meta.url);

/**
 * What an administrator wants to know about the running site at a glance:
 * which runtime, how long since it last restarted, and how full the disk is.
 *
 * Only values that are safe to show: no environment dump, no secrets. The Fly
 * variables read here (region, machine, image) are set by the platform and
 * identify the deploy, nothing more.
 */

/** 93784 -> "1 day, 2 hours, 3 minutes". */
function formatDuration(seconds) {
  const parts = [];
  const units = [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  let left = Math.floor(seconds);
  for (const [name, size] of units) {
    const n = Math.floor(left / size);
    left -= n * size;
    if (n > 0) parts.push(`${n} ${name}${n === 1 ? '' : 's'}`);
  }
  return parts.slice(0, 3).join(', ') || 'under a minute';
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

export function systemInfo() {
  const memory = process.memoryUsage();
  const startedAt = new Date(Date.now() - process.uptime() * 1000);

  let disk = null;
  try {
    const s = fs.statfsSync(config.dataDir);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    disk = {
      total: formatBytes(total),
      free: formatBytes(free),
      usedPercent: Math.round((1 - free / total) * 100),
    };
  } catch {
    /* the page still renders without it */
  }

  let schema = null;
  try {
    schema = get('SELECT MAX(version) AS v FROM schema_migrations')?.v ?? null;
  } catch {
    /* ditto */
  }

  let appVersion = null;
  try {
    appVersion = require('../../package.json').version;
  } catch {
    /* ditto */
  }

  const db = fileSize(config.dbFile);
  const wal = fileSize(`${config.dbFile}-wal`);

  return {
    startedAt: startedAt.toISOString(),
    uptime: formatDuration(process.uptime()),
    nodeVersion: process.version,
    appVersion,
    environment: config.isProd ? 'production' : 'development',
    platform: `${os.type()} ${os.arch()}`,
    timezone: TZ,
    pid: process.pid,
    memory: `${formatBytes(memory.rss)} in use`,
    heap: `${formatBytes(memory.heapUsed)} of ${formatBytes(memory.heapTotal)}`,
    machineMemory: formatBytes(os.totalmem()),
    database: db === null ? null : formatBytes(db),
    wal: wal === null ? null : formatBytes(wal),
    schema,
    disk,
    dataDir: config.dataDir,
    baseUrl: config.site.baseUrl,
    backupConfigured: Boolean(config.backup?.replicaUrl || process.env.BUCKET_NAME),
    scheduler: config.scheduler?.enabled ?? null,
    fly: process.env.FLY_APP_NAME
      ? {
          app: process.env.FLY_APP_NAME,
          region: process.env.FLY_REGION || null,
          machine: process.env.FLY_MACHINE_ID || null,
          image: process.env.FLY_IMAGE_REF || null,
        }
      : null,
  };
}
