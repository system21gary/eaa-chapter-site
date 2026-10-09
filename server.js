import config from './src/config.js';
import { createApp } from './src/app.js';
import { startMailWorker, stopMailWorker, closeMailTransport, outboxHealth } from './src/lib/mailer.js';

const app = createApp();

const server = app.listen(config.port, config.host, () => {
  console.log(`\n  EAA Chapter 1699 — ${config.env}`);
  console.log(`  http://localhost:${config.port}\n`);

  // Started here rather than in createApp() so importing the app for a test or
  // a script never quietly starts sending real email.
  if (startMailWorker()) {
    const { pending, abandoned } = outboxHealth();
    console.log(
      `  Mail: SMTP via ${config.mail.smtp.host}:${config.mail.smtp.port}` +
        `, worker every ${config.mail.pollSeconds}s (${pending} queued, ${abandoned} given up on)\n`
    );
  } else {
    console.log('  Mail: queued to the database only — nothing is delivered (MAIL_TRANSPORT=outbox).\n');
  }

  if (config.isDev) {
    console.log('  Seed the demo content with:  npm run seed');
    console.log('  Queued email (invites, resets) prints to this console.\n');
  }
});

// Give in-flight requests a chance to finish before the process exits, so a
// deploy never truncates someone's upload.
function shutdown(signal) {
  console.log(`\n[${signal}] shutting down…`);
  stopMailWorker();
  server.close(async () => {
    // Closing the pool sends QUIT instead of dropping the connection, which
    // some relays count against you.
    await closeMailTransport().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
