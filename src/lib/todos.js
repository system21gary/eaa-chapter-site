import { all, get } from '../db/index.js';
import * as Users from '../models/users.js';
import * as Tools from '../models/tools.js';
import * as Applications from '../models/applications.js';
import * as Contact from '../models/contact.js';
import * as Notices from './notices.js';
import * as Minutes from './minutes.js';
import { isPaused } from './scheduler.js';
import { whenOf } from './event-format.js';

/**
 * A person's to-do list for the dashboard: things only they can act on, and
 * nothing else. An ordinary member usually has none; officers and
 * administrators have whatever is waiting on their office.
 *
 *   everyone        borrow requests on their own tools
 *   approvers       documents to review; meeting notices to approve
 *                   (President and Vice President; the Secretary for notices)
 *   publishers      approved documents not yet visible to members
 *   any officer     their own documents that came back with changes requested,
 *                   and their own drafts not yet sent for review
 *   editors/admins  messages in the inbox
 *   administrators  membership requests, emails that could not be delivered,
 *                   scheduled sending that has been paused
 *
 * Each item is `{ kind, title, detail, href, tone, when }`. `tone: 'late'` is
 * something already overdue; those sort first.
 */
export function todosFor(user, { now = new Date() } = {}) {
  const items = [];
  const officer = Users.isBoard(user);

  /* ---------------------------------------------------------- notices */
  if (Users.canApproveNotice(user)) {
    for (const n of Notices.listAwaitingApproval()) {
      const overdue = new Date(n.send_at) <= now;
      items.push({
        kind: 'Meeting notice',
        title: `Approve the notice for ${n.event_title}`,
        detail: overdue
          ? `${whenOf(n).long}. It was due to go to members already; it will not be sent until it is approved.`
          : `${whenOf(n).long}. It goes to members on approval at the scheduled time.`,
        href: `/members/documents/notices/${n.id}`,
        tone: overdue ? 'late' : 'normal',
        when: n.send_at,
      });
    }
  }

  /* -------------------------------------------------------- documents */
  const doc = (sql, params = []) =>
    all(
      `SELECT d.id, d.title, d.updated_at, v.number AS latest
         FROM documents d
         JOIN document_versions v ON v.document_id = d.id
          AND v.number = (SELECT MAX(number) FROM document_versions WHERE document_id = d.id)
        WHERE ${sql} ORDER BY d.updated_at`,
      params
    );

  if (Users.canApprove(user)) {
    for (const d of doc("d.status = 'in_review'")) {
      items.push({
        kind: 'Document',
        title: `Review: ${d.title}`,
        detail: `Version ${d.latest} is waiting for a decision.`,
        href: `/members/documents/${d.id}`,
        tone: 'normal',
        when: d.updated_at,
      });
    }
  }
  if (Users.canPublish(user)) {
    for (const d of all(
      `SELECT d.id, d.title, d.updated_at FROM documents d
         JOIN document_versions v ON v.document_id = d.id
          AND v.number = (SELECT MAX(number) FROM document_versions WHERE document_id = d.id)
        WHERE d.status = 'approved' AND d.published_version_id IS NOT v.id ORDER BY d.updated_at`
    )) {
      items.push({
        kind: 'Document',
        title: `Publish: ${d.title}`,
        detail: 'Approved, and not yet visible to members.',
        href: `/members/documents/${d.id}`,
        tone: 'normal',
        when: d.updated_at,
      });
    }
  }
  if (officer) {
    for (const d of doc(
      `d.status = 'changes_requested' AND (d.created_by = ? OR EXISTS
         (SELECT 1 FROM document_versions s WHERE s.document_id = d.id AND s.submitted_by = ?))`,
      [user.id, user.id]
    )) {
      items.push({
        kind: 'Document',
        title: `Changes requested: ${d.title}`,
        detail: 'Upload a corrected version and send it for review again.',
        href: `/members/documents/${d.id}`,
        tone: 'normal',
        when: d.updated_at,
      });
    }
    for (const d of doc("d.status = 'draft' AND d.created_by = ?", [user.id])) {
      items.push({
        kind: 'Document',
        title: `Send for review: ${d.title}`,
        detail: 'Your draft has not been sent for review yet.',
        href: `/members/documents/${d.id}`,
        tone: 'normal',
        when: d.updated_at,
      });
    }
  }

  /* ---------------------------------------------------------- minutes */
  const owner = Minutes.isOwner(user);
  for (const t of Minutes.tasks({ now })) {
    if (t.state !== 'missing' || now < t.showFrom) continue;
    const e = t.event;
    const late = now >= t.nudgeFrom;
    if (owner) {
      items.push({
        kind: 'Minutes',
        title: `Write the minutes for ${e.title}`,
        detail: `The meeting was ${whenOf(e).long}. Add them as a file, or say none are needed.`,
        href: `/members/documents/board/new?kind=minutes&event=${e.id}`,
        tone: late ? 'late' : 'normal',
        when: e.starts_at,
        secondary: { label: 'Not needed', action: `/members/documents/minutes/${e.id}/not-needed`, confirm: `No minutes are needed for ${e.title}? The reminders will stop.` },
      });
    } else if (Users.canApprove(user) && now >= t.escalateFrom) {
      items.push({
        kind: 'Minutes',
        title: `Minutes overdue: ${e.title}`,
        detail: `${whenOf(e).long}. No minutes have been added yet; the Secretary has been reminded.`,
        href: '/members/documents/board',
        tone: 'late',
        when: e.starts_at,
      });
    }
  }

  /* ------------------------------------------------------------- site */
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  if (['editor', 'admin'].includes(user.role)) {
    const waiting = Contact.waitingCount();
    if (waiting) {
      items.push({ kind: 'Inbox', title: `${plural(waiting, 'message')} to answer`, detail: 'Sent through the contact form.', href: '/members/admin/messages', tone: 'normal' });
    }
  }
  if (user.role === 'admin') {
    const pending = Applications.pendingCount();
    if (pending) {
      items.push({ kind: 'Requests', title: `${plural(pending, 'membership request')} to review`, detail: 'People asking for an account.', href: '/members/admin/applications', tone: 'normal' });
    }
    // "Not sent: reserved domain" rows are the demo content, not a fault.
    const failed = get("SELECT COUNT(*) AS n FROM email_outbox WHERE sent_at IS NULL AND next_attempt_at IS NULL AND error IS NOT NULL AND error NOT LIKE 'not sent:%'").n;
    if (failed) {
      items.push({ kind: 'Email', title: `${plural(failed, 'email')} could not be delivered`, detail: 'Delivery was tried and given up on. Retry from the activity log.', href: '/members/admin/log', tone: 'late' });
    }
    if (isPaused()) {
      items.push({ kind: 'Automation', title: 'Scheduled sending is paused', detail: 'Reminders and meeting notices will not go out until it is resumed.', href: '/members/admin/schedule', tone: 'late' });
    }
  }

  /* ---------------------------------------------------------- everyone */
  const borrow = Tools.pendingRequestCount(user.id);
  if (borrow) {
    items.push({ kind: 'Tool Locker', title: `${plural(borrow, 'borrow request')} waiting on you`, detail: 'Somebody wants to borrow one of your tools.', href: '/members/locker/requests', tone: 'normal' });
  }

  // Overdue first; otherwise the order above (what only their office can do comes before housekeeping).
  return items.map((item, i) => ({ item, i })).sort((a, b) => (b.item.tone === 'late') - (a.item.tone === 'late') || a.i - b.i).map((x) => x.item);
}

/** Whether to show the section even when it is empty ("all caught up"). Ordinary members get nothing. */
export const hasDuties = (user) => user.role !== 'member' || Users.isBoard(user);
