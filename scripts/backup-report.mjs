/**
 * Runs the backup check now, instead of waiting for the morning.
 *
 *   npm run backup:report              print the report; send nothing
 *   npm run backup:report -- --send    also email it to the usual recipients
 *
 * On Fly, run it through start.sh so it sees the same backup settings as the
 * site:
 *
 *   fly ssh console -C "/app/scripts/start.sh npm run backup:report"
 *
 * Exits 1 when the report says PROBLEM, so it can be used in a script.
 */
import { buildReport, formatReport, sendReport } from '../src/lib/backup-report.js';
import { deliverOutbox, closeMailTransport } from '../src/lib/mailer.js';
import config from '../src/config.js';

const send = process.argv.includes('--send');

if (send) {
  const { report, message, recipients } = await sendReport();
  console.log(`${message.subject}\n\n${message.text}\n`);
  console.log(`Queued for: ${recipients.join(', ') || '(nobody: no active administrators)'}`);
  if (config.mail.transport === 'smtp') {
    await deliverOutbox();
    console.log('Delivered (or queued for retry: see the activity log).');
  } else {
    console.log('MAIL_TRANSPORT is not smtp, so it was queued but not delivered.');
  }
  await closeMailTransport().catch(() => {});
  process.exit(report.status === 'PROBLEM' ? 1 : 0);
} else {
  const report = await buildReport();
  const message = formatReport(report);
  console.log(`${message.subject}\n\n${message.text}`);
  process.exit(report.status === 'PROBLEM' ? 1 : 0);
}
