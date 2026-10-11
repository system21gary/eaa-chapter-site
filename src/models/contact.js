import { get } from '../db/index.js';

/** Contact messages nobody has replied to or marked handled yet. */
export function waitingCount() {
  return get(
    'SELECT COUNT(*) AS n FROM contact_messages WHERE handled_at IS NULL AND archived_at IS NULL'
  ).n;
}
