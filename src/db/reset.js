import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import config from '../config.js';

/**
 * Wipes the database and every uploaded file. Development convenience only --
 * it refuses to run in production, and asks first everywhere else.
 */
if (config.isProd) {
  console.error('[reset] refusing to run with NODE_ENV=production.');
  process.exit(1);
}

const targets = [
  config.dbFile,
  `${config.dbFile}-wal`,
  `${config.dbFile}-shm`,
];

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question(
  `This deletes ${path.basename(config.dbFile)} and everything in ${config.uploadDir}.\nType "yes" to continue: `
);
rl.close();

if (answer.trim().toLowerCase() !== 'yes') {
  console.log('[reset] cancelled.');
  process.exit(0);
}

for (const file of targets) {
  fs.rmSync(file, { force: true });
}
fs.rmSync(config.uploadDir, { recursive: true, force: true });

console.log('[reset] done. Run `npm run seed` to rebuild the demo content.');
