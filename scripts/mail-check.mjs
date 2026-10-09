/**
 * Checks that outbound email actually works.
 *
 *   npm run mail:check                      -- connect and authenticate only
 *   npm run mail:check -- you@example.com   -- also send a real test message
 *   npm run mail:check -- --drain           -- deliver anything due in the queue
 *
 * Run this before switching the live site over. It exercises exactly the path
 * the site uses -- same config, same transport, same TLS settings -- so if this
 * passes, invitations and password resets will go out.
 *
 * No credential value is printed, here or on failure.
 */
import config from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import {
  verifyTransport,
  sendMail,
  deliverOutbox,
  outboxHealth,
  closeMailTransport,
} from '../src/lib/mailer.js';

const args = process.argv.slice(2);
const drainOnly = args.includes('--drain');
const recipient = args.find((a) => a.includes('@'));

const { host, port, secure, user, pass, requireTls, allowInvalidCerts } = config.mail.smtp;

console.log('\nMail configuration');
console.log(`  transport         ${config.mail.transport}`);
console.log(`  host              ${host || '(not set)'}`);
console.log(`  port              ${port} (${secure ? 'implicit TLS' : 'STARTTLS'})`);
// Presence, not value. The username is half of a credential pair.
console.log(`  SMTP_USER         ${user ? 'set' : 'NOT SET'}`);
console.log(`  SMTP_PASS         ${pass ? 'set' : 'NOT SET'}`);
console.log(`  require TLS       ${requireTls}`);
console.log(`  verify cert       ${!allowInvalidCerts}`);
console.log(`  From              ${config.mail.from}`);
console.log(`  Reply-To          ${config.mail.replyTo || '(none)'}`);

/**
 * Many providers -- IONOS, Microsoft 365, most shared hosting -- refuse to send
 * a message whose From address is not the mailbox that authenticated, and the
 * rejection arrives at the DATA stage with an unhelpful 550. Worth catching
 * here, where the answer is obvious.
 *
 * Compared, not printed: the addresses are half of a credential pair.
 */
const fromAddress = (config.mail.from.match(/<([^>]+)>/)?.[1] || config.mail.from).trim().toLowerCase();
if (user && user.includes('@') && fromAddress !== user.trim().toLowerCase()) {
  console.log(
    '\n  Note: MAIL_FROM is not the same address as SMTP_USER.\n' +
      '  Some providers (IONOS, Microsoft 365) reject that outright, and others\n' +
      '  let it through but land it in spam. If the send below fails with a 550,\n' +
      '  set MAIL_FROM to the mailbox you are authenticating as and put the\n' +
      '  address you want replies to go to in MAIL_REPLY_TO instead.'
  );
}

if (config.mail.transport !== 'smtp') {
  console.log(
    '\nMAIL_TRANSPORT is not "smtp", so nothing would be delivered.\n' +
      'Set MAIL_TRANSPORT=smtp with SMTP_HOST, SMTP_USER and SMTP_PASS, then run this again.\n'
  );
  process.exit(1);
}

migrate({ quiet: true });

let failed = false;

/* ------------------------------------------------------------ connect + auth */
process.stdout.write('\nConnecting and authenticating… ');
try {
  await verifyTransport();
  console.log('ok');
} catch (err) {
  console.log('FAILED');
  console.error(`\n  ${err.message}\n`);
  console.error(diagnose(err.message));
  await closeMailTransport();
  process.exit(1);
}

/* ------------------------------------------------------------- send one live */
if (recipient) {
  process.stdout.write(`Queueing a test message to ${recipient}… `);
  const { id } = await sendMail({
    to: recipient,
    subject: 'EAA Chapter 1699 — mail test',
    text: [
      'This is a test from the EAA Chapter 1699 website.',
      '',
      'If it reached you, outbound email is working: invitations and password',
      'reset links will arrive too.',
      '',
      'Nothing is required of you. You can delete this.',
    ].join('\n'),
  });
  console.log(`queued as #${id}`);

  process.stdout.write('Delivering… ');
  const result = await deliverOutbox();
  if (result.sent > 0) {
    console.log('sent');
    console.log(`\n  Check ${recipient}, including the spam folder.`);
    console.log('  Landing in spam means the DNS records need attention — see DEPLOY.md.\n');
  } else {
    console.log('FAILED');
    console.log('  The reason is recorded against the message in the activity log.\n');
    failed = true;
  }
} else if (drainOnly) {
  const result = await deliverOutbox({ limit: 100 });
  console.log(`\nDrained the queue: ${result.sent} sent, ${result.failed} failed.\n`);
  failed = result.failed > 0;
} else {
  console.log('\nConnection and credentials are good.');
  console.log('Add an address to send a real message:  npm run mail:check -- you@example.com\n');
}

const health = outboxHealth();
console.log(
  `Queue: ${health.pending} waiting, ${health.sent} sent, ${health.abandoned} given up on.\n`
);

await closeMailTransport();
process.exit(failed ? 1 : 0);

/** Turns the usual SMTP failures into the thing to actually go and change. */
function diagnose(message) {
  const m = message.toLowerCase();
  if (m.includes('etimedout') || m.includes('econnrefused') || m.includes('greeting')) {
    return [
      '  Could not reach the server. Usually one of:',
      `    - wrong port: 587 needs SMTP_SECURE=0, 465 needs SMTP_SECURE=1 (currently ${port}/${secure ? 'secure' : 'starttls'})`,
      '    - the host blocks outbound SMTP. Google Cloud blocks port 25 outright and',
      '      throttles 587; a provider like Postmark or SES over 587/465 is fine, a',
      '      direct-to-recipient relay is not.',
      '    - a typo in SMTP_HOST',
    ].join('\n');
  }
  if (m.includes('invalid login') || m.includes('535') || m.includes('authentication')) {
    return [
      '  The server rejected the credentials. Usually one of:',
      '    - Gmail/Workspace and most providers reject account passwords over SMTP.',
      '      You need an app-specific password, which requires 2-step verification on.',
      '    - the username is not the full email address',
      '    - a trailing space or quote crept into the .env value',
      '    - IMAP credentials for a mailbox that has SMTP sending disabled',
    ].join('\n');
  }
  if (m.includes('self signed') || m.includes('certificate')) {
    return (
      '  The server certificate did not verify. For a public provider this means\n' +
      '  something is wrong with the hostname; only set SMTP_ALLOW_INVALID_CERTS=1\n' +
      '  for an internal relay you control.'
    );
  }
  return '  See DEPLOY.md, "Email", for the settings each provider expects.';
}
