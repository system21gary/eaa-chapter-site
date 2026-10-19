import db, { get, run } from './index.js';

/**
 * Migrations are append-only. Each entry runs exactly once, in order, inside a
 * transaction, and the applied version is recorded in `schema_migrations`.
 */
const migrations = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
    ---------------------------------------------------------------- members
    CREATE TABLE users (
      id               INTEGER PRIMARY KEY,
      email            TEXT NOT NULL UNIQUE COLLATE NOCASE,
      email_verified   INTEGER NOT NULL DEFAULT 0,
      first_name       TEXT NOT NULL,
      last_name        TEXT NOT NULL,
      display_name     TEXT,
      phone            TEXT,
      eaa_number       TEXT,
      aircraft         TEXT,
      home_base        TEXT,
      bio              TEXT,
      avatar_path      TEXT,
      role             TEXT NOT NULL DEFAULT 'member'
                       CHECK (role IN ('member','editor','admin')),
      status           TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','active','suspended')),
      -- NULL until the member sets one through a reset link. We never store,
      -- transmit, or accept a plaintext password for storage.
      password_hash    TEXT,
      password_set_at  TEXT,
      failed_logins    INTEGER NOT NULL DEFAULT 0,
      locked_until     TEXT,
      last_login_at    TEXT,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    );
    CREATE INDEX idx_users_status ON users(status);

    -- Server-side session store. Deleting a row logs that browser out
    -- immediately, which is how "sign out everywhere" and the post-reset
    -- session purge work.
    CREATE TABLE sessions (
      sid        TEXT PRIMARY KEY,
      user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      data       TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX idx_sessions_user ON sessions(user_id);
    CREATE INDEX idx_sessions_expires ON sessions(expires_at);

    -- Only the SHA-256 of a reset token is stored, so a database leak does not
    -- hand an attacker usable reset links.
    CREATE TABLE password_reset_tokens (
      id           INTEGER PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash   TEXT NOT NULL UNIQUE,
      expires_at   TEXT NOT NULL,
      used_at      TEXT,
      requested_ip TEXT,
      created_at   TEXT NOT NULL
    );
    CREATE INDEX idx_reset_user ON password_reset_tokens(user_id);

    CREATE TABLE invites (
      id          INTEGER PRIMARY KEY,
      email       TEXT NOT NULL COLLATE NOCASE,
      token_hash  TEXT NOT NULL UNIQUE,
      role        TEXT NOT NULL DEFAULT 'member'
                  CHECK (role IN ('member','editor','admin')),
      invited_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      note        TEXT,
      expires_at  TEXT NOT NULL,
      accepted_at TEXT,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX idx_invites_email ON invites(email);

    ------------------------------------------------------------------- blog
    CREATE TABLE posts (
      id           INTEGER PRIMARY KEY,
      slug         TEXT NOT NULL UNIQUE,
      title        TEXT NOT NULL,
      summary      TEXT,
      body_md      TEXT NOT NULL,
      body_html    TEXT NOT NULL,
      cover_path   TEXT,
      cover_alt    TEXT,
      author_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      status       TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','published','archived')),
      -- 'members' posts never render outside an authenticated session.
      visibility   TEXT NOT NULL DEFAULT 'members'
                   CHECK (visibility IN ('members','public')),
      pinned       INTEGER NOT NULL DEFAULT 0,
      published_at TEXT,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );
    CREATE INDEX idx_posts_status ON posts(status, published_at DESC);

    CREATE TABLE post_tags (
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      tag     TEXT NOT NULL,
      PRIMARY KEY (post_id, tag)
    );
    CREATE INDEX idx_post_tags_tag ON post_tags(tag);

    -- Keeps an edit history so a bad edit is recoverable without backups.
    CREATE TABLE post_revisions (
      id         INTEGER PRIMARY KEY,
      post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      title      TEXT NOT NULL,
      body_md    TEXT NOT NULL,
      editor_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_revisions_post ON post_revisions(post_id, created_at DESC);

    CREATE TABLE comments (
      id         INTEGER PRIMARY KEY,
      post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body       TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'visible'
                 CHECK (status IN ('visible','hidden')),
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_comments_post ON comments(post_id, created_at);

    ------------------------------------------------------------ tool locker
    CREATE TABLE tool_categories (
      id    INTEGER PRIMARY KEY,
      slug  TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      icon  TEXT,
      sort  INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE tools (
      id             INTEGER PRIMARY KEY,
      owner_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category_id    INTEGER REFERENCES tool_categories(id) ON DELETE SET NULL,
      name           TEXT NOT NULL,
      brand          TEXT,
      model          TEXT,
      description    TEXT,
      condition      TEXT NOT NULL DEFAULT 'good'
                     CHECK (condition IN ('excellent','good','fair','needs-tlc')),
      availability   TEXT NOT NULL DEFAULT 'available'
                     CHECK (availability IN ('available','on-loan','unavailable')),
      location_label TEXT,
      location_notes TEXT,
      latitude       REAL,
      longitude      REAL,
      loan_terms     TEXT,
      requires_checkout INTEGER NOT NULL DEFAULT 0,
      deposit        TEXT,
      manual_url     TEXT,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
    CREATE INDEX idx_tools_owner ON tools(owner_id);
    CREATE INDEX idx_tools_category ON tools(category_id);
    CREATE INDEX idx_tools_availability ON tools(availability);

    CREATE TABLE tool_images (
      id         INTEGER PRIMARY KEY,
      tool_id    INTEGER NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
      full_path  TEXT NOT NULL,
      thumb_path TEXT NOT NULL,
      alt        TEXT,
      width      INTEGER,
      height     INTEGER,
      sort       INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_tool_images_tool ON tool_images(tool_id, sort);

    CREATE TABLE borrow_requests (
      id            INTEGER PRIMARY KEY,
      tool_id       INTEGER NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
      requester_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message       TEXT NOT NULL,
      needed_from   TEXT,
      needed_to     TEXT,
      status        TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','declined','returned','cancelled')),
      owner_reply   TEXT,
      created_at    TEXT NOT NULL,
      responded_at  TEXT
    );
    CREATE INDEX idx_borrow_tool ON borrow_requests(tool_id, created_at DESC);
    CREATE INDEX idx_borrow_requester ON borrow_requests(requester_id);

    ----------------------------------------------------------------- events
    CREATE TABLE events (
      id             INTEGER PRIMARY KEY,
      slug           TEXT NOT NULL UNIQUE,
      title          TEXT NOT NULL,
      summary        TEXT,
      body_md        TEXT,
      body_html      TEXT,
      starts_at      TEXT NOT NULL,
      ends_at        TEXT,
      all_day        INTEGER NOT NULL DEFAULT 0,
      rain_date      TEXT,
      location_name  TEXT,
      address        TEXT,
      city           TEXT,
      state          TEXT,
      zip            TEXT,
      latitude       REAL,
      longitude      REAL,
      cost           TEXT,
      contact_name   TEXT,
      contact_email  TEXT,
      contact_phone  TEXT,
      external_url   TEXT,
      poster_path    TEXT,
      poster_alt     TEXT,
      kind           TEXT NOT NULL DEFAULT 'chapter'
                     CHECK (kind IN ('chapter','fly-in','young-eagles','workshop','meeting','social')),
      status         TEXT NOT NULL DEFAULT 'published'
                     CHECK (status IN ('draft','published','cancelled')),
      recap_md       TEXT,
      recap_html     TEXT,
      attendance     INTEGER,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
    CREATE INDEX idx_events_start ON events(starts_at);

    CREATE TABLE event_photos (
      id         INTEGER PRIMARY KEY,
      event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      full_path  TEXT NOT NULL,
      thumb_path TEXT NOT NULL,
      caption    TEXT,
      credit     TEXT,
      sort       INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_event_photos_event ON event_photos(event_id, sort);

    ------------------------------------------------------------- operations
    CREATE TABLE contact_messages (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      email      TEXT NOT NULL,
      topic      TEXT,
      message    TEXT NOT NULL,
      ip_hash    TEXT,
      user_agent TEXT,
      handled_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_contact_created ON contact_messages(created_at DESC);

    -- Security-relevant actions land here: logins, resets, role changes,
    -- content edits. Append-only by convention.
    CREATE TABLE audit_log (
      id         INTEGER PRIMARY KEY,
      user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action     TEXT NOT NULL,
      entity     TEXT,
      entity_id  TEXT,
      detail     TEXT,
      ip_hash    TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_audit_created ON audit_log(created_at DESC);
    CREATE INDEX idx_audit_action ON audit_log(action, created_at DESC);

    -- Until SMTP is configured, outbound mail is queued here so the chapter
    -- can still read reset links and notifications.
    CREATE TABLE email_outbox (
      id         INTEGER PRIMARY KEY,
      to_addr    TEXT NOT NULL,
      subject    TEXT NOT NULL,
      body_text  TEXT NOT NULL,
      body_html  TEXT,
      sent_at    TEXT,
      error      TEXT,
      created_at TEXT NOT NULL
    );
    `,
  },
  {
    version: 2,
    name: 'members project build logs',
    sql: `
    -- A member's aircraft project. Public by default, because showing the
    -- work is most of the point of a chapter -- but a member can keep a
    -- project members-only if they would rather not advertise a hangar full
    -- of expensive parts to the open internet.
    CREATE TABLE builds (
      id               INTEGER PRIMARY KEY,
      owner_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      slug             TEXT NOT NULL UNIQUE,
      title            TEXT NOT NULL,
      aircraft_type    TEXT NOT NULL,
      tail_number      TEXT,
      build_kind       TEXT NOT NULL DEFAULT 'kit'
                       CHECK (build_kind IN ('kit','plans','restoration','maintenance','ultralight','other')),
      status           TEXT NOT NULL DEFAULT 'building'
                       CHECK (status IN ('planning','building','painting','inspection','flying','paused','sold')),
      percent_complete INTEGER NOT NULL DEFAULT 0
                       CHECK (percent_complete BETWEEN 0 AND 100),
      started_on       TEXT,
      first_flight_on  TEXT,
      engine           TEXT,
      panel            TEXT,
      hangar           TEXT,
      summary          TEXT,
      body_md          TEXT,
      body_html        TEXT,
      cover_path       TEXT,
      cover_alt        TEXT,
      external_log_url TEXT,
      visibility       TEXT NOT NULL DEFAULT 'public'
                       CHECK (visibility IN ('public','members')),
      featured         INTEGER NOT NULL DEFAULT 0,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    );
    CREATE INDEX idx_builds_owner ON builds(owner_id);
    CREATE INDEX idx_builds_visibility ON builds(visibility, updated_at DESC);

    -- One entry in the build log: "Riveted the left tank. Do not ask about
    -- the proseal." Ordered by posted_at so a member can back-date an entry
    -- they meant to write six months ago.
    CREATE TABLE build_updates (
      id         INTEGER PRIMARY KEY,
      build_id   INTEGER NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
      author_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      title      TEXT NOT NULL,
      body_md    TEXT NOT NULL,
      body_html  TEXT NOT NULL,
      hours      REAL,
      status     TEXT NOT NULL DEFAULT 'published'
                 CHECK (status IN ('draft','published')),
      posted_at  TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_build_updates_build ON build_updates(build_id, posted_at DESC);

    CREATE TABLE build_update_photos (
      id         INTEGER PRIMARY KEY,
      update_id  INTEGER NOT NULL REFERENCES build_updates(id) ON DELETE CASCADE,
      full_path  TEXT NOT NULL,
      thumb_path TEXT NOT NULL,
      caption    TEXT,
      sort       INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_build_photos_update ON build_update_photos(update_id, sort);

    -- Lightweight encouragement from other members. Not a comment thread --
    -- just a way to say "nice work" without another moderation surface.
    CREATE TABLE build_cheers (
      build_id   INTEGER NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (build_id, user_id)
    );
    `,
  },
  {
    version: 3,
    name: 'membership applications',
    sql: `
    -- Public "request an account" submissions, awaiting an administrator.
    --
    -- Applications live in their own table rather than as half-made user rows,
    -- so an unreviewed request has no id anywhere in the members' world: it
    -- cannot be granted a session, cannot appear in the directory, and cannot
    -- be referenced by a tool or a build. A user record is only created at the
    -- moment an administrator approves.
    CREATE TABLE membership_applications (
      id          INTEGER PRIMARY KEY,
      first_name  TEXT NOT NULL,
      last_name   TEXT NOT NULL,
      email       TEXT NOT NULL COLLATE NOCASE,
      phone       TEXT,
      eaa_number  TEXT,
      aircraft    TEXT,
      home_base   TEXT,
      interest    TEXT,
      message     TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','declined')),
      reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TEXT,
      review_note TEXT,
      -- Set when approved, linking the application to the account it produced.
      user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      ip_hash     TEXT,
      user_agent  TEXT,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX idx_applications_status ON membership_applications(status, created_at DESC);

    -- At most one open application per address. The insert that violates this
    -- is swallowed and answered with the same generic message as a success,
    -- so the form cannot be used to test whether an address is already known.
    CREATE UNIQUE INDEX idx_applications_open_email
      ON membership_applications(email) WHERE status = 'pending';
    `,
  },
  {
    version: 4,
    name: 'outbox delivery queue',
    sql: `
    -- Turns email_outbox from a record of what the site wanted to send into a
    -- delivery queue with retries.
    --
    -- Sending inside the request that triggered it would be wrong in two ways.
    -- A transient relay failure would show the member an error page for an
    -- action that actually succeeded, and on /forgot it would answer differently
    -- for a known address (mail attempted, may throw) than an unknown one (no
    -- mail, always fine) -- handing an attacker the account-enumeration oracle
    -- that page is carefully written to withhold. So requests only ever queue,
    -- and a background worker delivers.
    ALTER TABLE email_outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE email_outbox ADD COLUMN last_attempt_at TEXT;

    -- When the worker should next try. NULL means never: either already sent,
    -- or queued before a transport existed, or given up on after the last
    -- retry. Failure is therefore visible (error is set) without the row
    -- silently retrying for ever.
    ALTER TABLE email_outbox ADD COLUMN next_attempt_at TEXT;

    -- Reply-To, so an officer can answer a contact-form message directly
    -- instead of retyping the address out of the body.
    ALTER TABLE email_outbox ADD COLUMN reply_to TEXT;

    CREATE INDEX idx_outbox_due ON email_outbox(next_attempt_at)
      WHERE sent_at IS NULL AND next_attempt_at IS NOT NULL;

    -- Deliberately no backfill. Rows queued before this point keep
    -- next_attempt_at NULL, so switching MAIL_TRANSPORT to smtp does not
    -- suddenly post the entire demo backlog -- which is addressed to fictional
    -- members at made-up addresses, and would earn the chapter's brand-new
    -- domain a pile of bounces on its first day. Anything genuinely worth
    -- sending can be requeued one row at a time from the activity log.
    `,
  },
  {
    version: 5,
    name: 'app state',
    sql: `
    -- Small bits of state the server keeps for itself, such as the date the
    -- nightly backup report last went out. Kept in the database rather than
    -- in memory so a restart or a deploy does not send the same day's report
    -- twice.
    CREATE TABLE app_state (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    `,
  },
  {
    version: 6,
    name: 'demo content: 4B0 has a paved runway',
    sql: `
    -- The demo content described South Albany as a grass field. 4B0 has one
    -- paved runway, 01/19, 2,853 x 60 ft asphalt. Sites seeded before this
    -- fix still carry the old wording in their database, so correct it here.
    --
    -- Each REPLACE matches an exact sentence from the old seed, so it changes
    -- nothing a member has since written or edited, and does nothing at all on
    -- a site seeded after the fix.
    UPDATE events SET
      body_md = REPLACE(body_md,
        'Aircraft parking on the grass north of the hangars. Car parking in the usual field — follow the signs and the person waving.',
        'Volunteers will direct you to aircraft parking once you are clear of the runway. Car parking is signposted — follow the signs and the person waving.'),
      body_html = REPLACE(body_html,
        'Aircraft parking on the grass north of the hangars. Car parking in the usual field — follow the signs and the person waving.',
        'Volunteers will direct you to aircraft parking once you are clear of the runway. Car parking is signposted — follow the signs and the person waving.');

    UPDATE events SET poster_alt = REPLACE(poster_alt,
      'flying low over a grass field while families wave', 'flying low over green fields while families wave');
    UPDATE events SET poster_alt = REPLACE(poster_alt,
      'taildragger flying over a grass field beside a pancake', 'taildragger flying over green fields beside a pancake');

    UPDATE contact_messages SET message = REPLACE(message,
      'What are the current field conditions and is there room on the grass for a nosewheel aircraft? First time in.',
      'Is there transient parking for a Cherokee, and is self-serve fuel available on a Sunday morning? First time in.');
    `,
  },
  {
    version: 7,
    name: 'chapter time cutoff',
    sql: `
    -- Dates typed into forms used to be read in the server's own time zone.
    -- On Fly that is UTC, so 7 PM was stored as 7 PM UTC and shown as 3 PM
    -- Eastern. Form text is now read as chapter time (lib/localtime.js).
    --
    -- Rows saved before this point may carry the old error; rows saved after
    -- it do not. Record the moment -- this migration runs the first time the
    -- fixed code starts -- so scripts/fix-times.mjs can correct exactly the
    -- former and never touch the latter.
    INSERT OR IGNORE INTO app_state (key, value, updated_at)
    VALUES ('chapter_time_since', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    `,
  },
  {
    version: 8,
    name: 'archive membership applications',
    sql: `
    -- Cleared requests disappear from the admin screen but the row stays, so
    -- the chapter can still report on who asked and what was decided.
    ALTER TABLE membership_applications ADD COLUMN archived_at TEXT;
    ALTER TABLE membership_applications ADD COLUMN archived_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
    `,
  },
  {
    version: 9,
    name: 'contact message handling',
    sql: `
    -- Who dealt with a message, and a way to clear it from the inbox without
    -- losing it: archived rows are hidden, never deleted, so they can still be
    -- reported on.
    ALTER TABLE contact_messages ADD COLUMN handled_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE contact_messages ADD COLUMN archived_at TEXT;
    ALTER TABLE contact_messages ADD COLUMN archived_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

    -- Replies sent from the site. The visitor's address stays on the message
    -- row; it is not copied here.
    CREATE TABLE contact_replies (
      id         INTEGER PRIMARY KEY,
      message_id INTEGER NOT NULL REFERENCES contact_messages(id) ON DELETE CASCADE,
      sent_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      body       TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_contact_replies_message ON contact_replies(message_id, created_at);
    `,
  },
  {
    version: 10,
    name: 'member directory privacy',
    sql: `
    -- Members choose whether other members can see their email and phone in
    -- the directory. Existing members stay visible, as they were before the
    -- choice existed; they can hide either from their account page.
    ALTER TABLE users ADD COLUMN share_email INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE users ADD COLUMN share_phone INTEGER NOT NULL DEFAULT 1;
    `,
  },
  {
    version: 11,
    name: 'site stats',
    sql: `
    -- Aggregate counters only. No IP addresses, no user agents, no per-visit
    -- rows: one row per day, page, audience, referring site and device class.
    -- "audience" is who was looking: a signed-out 'visitor' or a signed-in 'member'.
    CREATE TABLE stats_daily (
      day      TEXT NOT NULL,
      audience TEXT NOT NULL CHECK (audience IN ('visitor','member')),
      path     TEXT NOT NULL,
      referrer TEXT NOT NULL DEFAULT '',
      campaign TEXT NOT NULL DEFAULT '',
      device   TEXT NOT NULL DEFAULT 'desktop',
      views    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, audience, path, referrer, campaign, device)
    ) WITHOUT ROWID;
    CREATE INDEX idx_stats_daily_path ON stats_daily(path, day);

    -- Roughly how many different people came each day. Counted from a one-way
    -- fingerprint that is held in memory and changes every day, never stored.
    CREATE TABLE stats_visitors (
      day      TEXT NOT NULL,
      audience TEXT NOT NULL CHECK (audience IN ('visitor','member')),
      visitors INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, audience)
    ) WITHOUT ROWID;

    -- Things that are not page views: calendar downloads, clicks out to an
    -- event's external listing.
    CREATE TABLE stats_events (
      day    TEXT NOT NULL,
      name   TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      count  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, name, detail)
    ) WITHOUT ROWID;
    `,
  },
  {
    version: 12,
    name: 'site stats: engagement',
    sql: `
    -- One row per day, audience and way in (landing page + referrer + tag +
    -- device). Totals only. visits = people who started here; engaged = went
    -- on to a second page; acted = did something that counts (calendar,
    -- directions, listing, contact, join); quiet = looked at one page and did
    -- nothing else.
    CREATE TABLE stats_visits (
      day        TEXT NOT NULL,
      audience   TEXT NOT NULL CHECK (audience IN ('visitor','member')),
      entry_path TEXT NOT NULL,
      referrer   TEXT NOT NULL DEFAULT '',
      campaign   TEXT NOT NULL DEFAULT '',
      device     TEXT NOT NULL DEFAULT 'desktop',
      visits     INTEGER NOT NULL DEFAULT 0,
      engaged    INTEGER NOT NULL DEFAULT 0,
      acted      INTEGER NOT NULL DEFAULT 0,
      quiet      INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, audience, entry_path, referrer, campaign, device)
    ) WITHOUT ROWID;

    -- How many pages each day's visits looked at: '1', '2', '3-5', '6+'.
    CREATE TABLE stats_depth (
      day      TEXT NOT NULL,
      audience TEXT NOT NULL CHECK (audience IN ('visitor','member')),
      bucket   TEXT NOT NULL,
      visits   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, audience, bucket)
    ) WITHOUT ROWID;

    -- How long people stayed on a page and how far down they got, in coarse
    -- buckets, reported by a small script in the page.
    CREATE TABLE stats_attention (
      day      TEXT NOT NULL,
      audience TEXT NOT NULL CHECK (audience IN ('visitor','member')),
      path     TEXT NOT NULL,
      secs     TEXT NOT NULL,
      scroll   TEXT NOT NULL,
      n        INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, audience, path, secs, scroll)
    ) WITHOUT ROWID;
    `,
  },
  {
    version: 13,
    name: 'site stats: officers counted separately',
    sql: `
    -- Admins and editors testing the site should not mix with real traffic, so
    -- they get their own audience, 'staff'. SQLite cannot change a CHECK
    -- constraint in place, so each stats table is rebuilt with the wider rule
    -- and its rows copied across. Event clicks also learn who made them
    -- (rows recorded before this are filed under 'visitor').
    CREATE TABLE stats_daily_new (
      day TEXT NOT NULL, audience TEXT NOT NULL CHECK (audience IN ('visitor','member','staff')),
      path TEXT NOT NULL, referrer TEXT NOT NULL DEFAULT '', campaign TEXT NOT NULL DEFAULT '',
      device TEXT NOT NULL DEFAULT 'desktop', views INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, audience, path, referrer, campaign, device)
    ) WITHOUT ROWID;
    INSERT INTO stats_daily_new SELECT day, audience, path, referrer, campaign, device, views FROM stats_daily;
    DROP TABLE stats_daily;
    ALTER TABLE stats_daily_new RENAME TO stats_daily;
    CREATE INDEX idx_stats_daily_path ON stats_daily(path, day);

    CREATE TABLE stats_visitors_new (
      day TEXT NOT NULL, audience TEXT NOT NULL CHECK (audience IN ('visitor','member','staff')),
      visitors INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, audience)
    ) WITHOUT ROWID;
    INSERT INTO stats_visitors_new SELECT day, audience, visitors FROM stats_visitors;
    DROP TABLE stats_visitors;
    ALTER TABLE stats_visitors_new RENAME TO stats_visitors;

    CREATE TABLE stats_events_new (
      day TEXT NOT NULL, audience TEXT NOT NULL DEFAULT 'visitor' CHECK (audience IN ('visitor','member','staff')),
      name TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, audience, name, detail)
    ) WITHOUT ROWID;
    INSERT INTO stats_events_new (day, audience, name, detail, count)
      SELECT day, 'visitor', name, detail, count FROM stats_events;
    DROP TABLE stats_events;
    ALTER TABLE stats_events_new RENAME TO stats_events;

    CREATE TABLE stats_visits_new (
      day TEXT NOT NULL, audience TEXT NOT NULL CHECK (audience IN ('visitor','member','staff')),
      entry_path TEXT NOT NULL, referrer TEXT NOT NULL DEFAULT '', campaign TEXT NOT NULL DEFAULT '',
      device TEXT NOT NULL DEFAULT 'desktop', visits INTEGER NOT NULL DEFAULT 0, engaged INTEGER NOT NULL DEFAULT 0,
      acted INTEGER NOT NULL DEFAULT 0, quiet INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, audience, entry_path, referrer, campaign, device)
    ) WITHOUT ROWID;
    INSERT INTO stats_visits_new SELECT day, audience, entry_path, referrer, campaign, device, visits, engaged, acted, quiet FROM stats_visits;
    DROP TABLE stats_visits;
    ALTER TABLE stats_visits_new RENAME TO stats_visits;

    CREATE TABLE stats_depth_new (
      day TEXT NOT NULL, audience TEXT NOT NULL CHECK (audience IN ('visitor','member','staff')),
      bucket TEXT NOT NULL, visits INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, audience, bucket)
    ) WITHOUT ROWID;
    INSERT INTO stats_depth_new SELECT day, audience, bucket, visits FROM stats_depth;
    DROP TABLE stats_depth;
    ALTER TABLE stats_depth_new RENAME TO stats_depth;

    CREATE TABLE stats_attention_new (
      day TEXT NOT NULL, audience TEXT NOT NULL CHECK (audience IN ('visitor','member','staff')),
      path TEXT NOT NULL, secs TEXT NOT NULL, scroll TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, audience, path, secs, scroll)
    ) WITHOUT ROWID;
    INSERT INTO stats_attention_new SELECT day, audience, path, secs, scroll, n FROM stats_attention;
    DROP TABLE stats_attention;
    ALTER TABLE stats_attention_new RENAME TO stats_attention;
    `,
  },
  {
    version: 14,
    name: 'copy people on inbound requests and messages',
    sql: `
    -- Which people are copied (Cc) when a membership request or a contact-form
    -- message arrives. Off for everyone until an administrator turns it on, so
    -- nothing changes the day this is deployed.
    ALTER TABLE users ADD COLUMN cc_membership_requests INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN cc_contact_messages INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE email_outbox ADD COLUMN cc TEXT;
    `,
  },
  {
    version: 15,
    name: 'board offices and email preferences',
    sql: `
    -- The chapter's officers. Separate from role (member/editor/admin), which
    -- is about what someone can do to the site; this is about who holds which
    -- office. NULL for everyone who is not an officer. One holder per office.
    ALTER TABLE users ADD COLUMN board_role TEXT
      CHECK (board_role IN ('president', 'vice_president', 'secretary', 'treasurer'));
    CREATE UNIQUE INDEX idx_users_board_role ON users(board_role) WHERE board_role IS NOT NULL;

    -- Optional mail a member can switch off. Everything else (invitations,
    -- password resets, board and records notices) is not optional. On for
    -- everyone until they choose otherwise.
    ALTER TABLE users ADD COLUMN mail_newsletter INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE users ADD COLUMN mail_meeting_notices INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE users ADD COLUMN mail_reminders INTEGER NOT NULL DEFAULT 1;
    `,
  },
  {
    version: 16,
    name: 'board documents with review and approval',
    sql: `
    -- Chapter records. The approved file (a PDF, usually) is the record; the
    -- site holds the index, the approval trail and the members' archive.
    CREATE TABLE documents (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      kind                 TEXT NOT NULL CHECK (kind IN ('minutes', 'agenda', 'financial', 'newsletter', 'bylaws', 'other')),
      title                TEXT NOT NULL,
      meeting_date         TEXT,
      status               TEXT NOT NULL DEFAULT 'draft'
                             CHECK (status IN ('draft', 'in_review', 'changes_requested', 'approved')),
      visibility           TEXT NOT NULL DEFAULT 'board' CHECK (visibility IN ('board', 'members')),
      -- The version members can see. NULL while the document is board-only. A
      -- revision in progress does not disturb it: the last approved version stays
      -- up until a newer one is approved and published.
      published_version_id INTEGER,
      created_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at           TEXT NOT NULL,
      updated_at           TEXT NOT NULL
    );
    CREATE INDEX idx_documents_status ON documents(status, updated_at);

    CREATE TABLE document_versions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id   INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      number        INTEGER NOT NULL,
      original_name TEXT NOT NULL,
      stored_name   TEXT NOT NULL UNIQUE,
      mime          TEXT NOT NULL,
      size          INTEGER NOT NULL,
      sha256        TEXT NOT NULL,
      note          TEXT,
      created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at    TEXT NOT NULL,
      submitted_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      submitted_at  TEXT,
      UNIQUE (document_id, number)
    );

    -- Approvals are recorded against one specific version, with the reviewer's
    -- office at the time, so a later change of officers does not rewrite who
    -- approved what.
    CREATE TABLE document_reviews (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      version_id      INTEGER NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
      reviewer_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewer_office TEXT,
      decision        TEXT NOT NULL CHECK (decision IN ('approved', 'changes_requested')),
      comment         TEXT,
      created_at      TEXT NOT NULL
    );
    `,
  },
  {
    version: 17,
    name: 'document history',
    sql: `
    -- A running history for each document: who added, sent, approved,
    -- published, took down or deleted what, and when. Names are copied in as
    -- text, with the person's office at the time, so the history still reads
    -- correctly after somebody leaves or an office changes hands. Deleted
    -- versions leave a line here and nothing else.
    CREATE TABLE document_events (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id    INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      version_number INTEGER,
      action         TEXT NOT NULL,
      actor_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
      actor_label    TEXT,
      detail         TEXT,
      created_at     TEXT NOT NULL
    );
    CREATE INDEX idx_document_events_doc ON document_events(document_id, id);

    -- Version numbers are never reused, even after a deletion.
    ALTER TABLE documents ADD COLUMN next_version INTEGER NOT NULL DEFAULT 1;
    UPDATE documents SET next_version =
      (SELECT COALESCE(MAX(number), 0) + 1 FROM document_versions v WHERE v.document_id = documents.id);

    -- Rebuild what is known from before this table existed. Publishing and
    -- taking down were not recorded with a time, so they are not reconstructed.
    INSERT INTO document_events (document_id, version_number, action, actor_id, actor_label, detail, created_at)
      SELECT v.document_id, v.number, CASE WHEN v.number = 1 THEN 'created' ELSE 'version_added' END,
             v.created_by, TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), v.original_name, v.created_at
        FROM document_versions v LEFT JOIN users u ON u.id = v.created_by;
    INSERT INTO document_events (document_id, version_number, action, actor_id, actor_label, detail, created_at)
      SELECT v.document_id, v.number, 'submitted', v.submitted_by,
             TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), NULL, v.submitted_at
        FROM document_versions v LEFT JOIN users u ON u.id = v.submitted_by
       WHERE v.submitted_at IS NOT NULL;
    INSERT INTO document_events (document_id, version_number, action, actor_id, actor_label, detail, created_at)
      SELECT v.document_id, v.number, r.decision, r.reviewer_id,
             TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) ||
               CASE r.reviewer_office WHEN 'president' THEN ' (President)' WHEN 'vice_president' THEN ' (Vice President)' ELSE '' END,
             r.comment, r.created_at
        FROM document_reviews r JOIN document_versions v ON v.id = r.version_id LEFT JOIN users u ON u.id = r.reviewer_id;
    `,
  },
  {
    version: 18,
    name: 'scheduled sends and mail headers',
    sql: `
    -- One row per automatic email the site has dealt with, so a restart or a
    -- deploy cannot send the same reminder twice: (rule, occurrence_key) is
    -- unique. The row is written BEFORE anything is queued ('sending'), which
    -- makes sending at-most-once: a crash part-way leaves a partial send
    -- rather than a repeat. An officer skipping a send ahead of time is the
    -- same row with status 'skipped'.
    CREATE TABLE scheduled_sends (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      rule           TEXT NOT NULL,
      occurrence_key TEXT NOT NULL,
      event_id       INTEGER REFERENCES events(id) ON DELETE SET NULL,
      due_at         TEXT NOT NULL,
      status         TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'skipped')),
      note           TEXT,
      recipients     INTEGER,
      created_at     TEXT NOT NULL,
      sent_at        TEXT,
      UNIQUE (rule, occurrence_key)
    );

    -- Extra headers (JSON) for a message: List-Unsubscribe on optional mail.
    ALTER TABLE email_outbox ADD COLUMN headers TEXT;
    `,
  },
  {
    version: 19,
    name: 'meeting notices',
    sql: `
    -- The notice that goes to members ahead of a meeting. The site drafts one
    -- about two weeks out; the President or Vice President approves it; it
    -- sends about ten days out (or at once if approved later) and is posted on
    -- the website. occurrence_key is the event plus its local date, so a
    -- meeting that moves gets a new notice instead of an old approval.
    CREATE TABLE notices (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id         INTEGER REFERENCES events(id) ON DELETE SET NULL,
      occurrence_key   TEXT NOT NULL UNIQUE,
      subject          TEXT NOT NULL,
      speaker          TEXT,
      agenda           TEXT,
      note             TEXT,
      status           TEXT NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft', 'approved', 'sending', 'sent', 'cancelled')),
      send_at          TEXT NOT NULL,
      -- A fingerprint of the event's date, place and title when it was approved.
      -- If any of those change afterwards the approval no longer stands.
      approved_facts   TEXT,
      approved_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      approved_label   TEXT,
      approved_at      TEXT,
      sent_at          TEXT,
      recipients       INTEGER,
      post_id          INTEGER REFERENCES posts(id) ON DELETE SET NULL,
      last_nudged_on   TEXT,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    );
    CREATE INDEX idx_notices_status ON notices(status, send_at);

    CREATE TABLE notice_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      notice_id   INTEGER NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
      action      TEXT NOT NULL,
      actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      actor_label TEXT,
      detail      TEXT,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX idx_notice_events_notice ON notice_events(notice_id, id);
    `,
  },
  {
    version: 20,
    name: 'reminders for every kind of event, and event updates',
    sql: `
    -- Which reminders an event sends. NULL means "the default for its type"
    -- (see lib/event-format.js): meetings and workshops the day before; fly-ins
    -- and Young Eagles days a week before and the day before; socials and
    -- general chapter events none.
    ALTER TABLE events ADD COLUMN reminders TEXT CHECK (reminders IN ('off', 'day', 'week_and_day'));

    -- Reminders are no longer only for meetings, and an event can have two. The
    -- rule is renamed and the occurrence key gains the lead (':day' or ':week'),
    -- so a reminder already sent is still recognised as sent and nothing repeats.
    UPDATE scheduled_sends SET rule = 'event_reminder', occurrence_key = occurrence_key || ':day'
     WHERE rule = 'meeting_reminder';

    -- Messages an editor sends to members about a change to an event: a new
    -- time or place, or a cancellation. A record of who said what, to how many.
    CREATE TABLE event_updates (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id    INTEGER REFERENCES events(id) ON DELETE SET NULL,
      event_title TEXT NOT NULL,
      kind        TEXT NOT NULL CHECK (kind IN ('update', 'cancelled')),
      message     TEXT NOT NULL,
      sent_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      sent_label  TEXT,
      recipients  INTEGER,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX idx_event_updates_event ON event_updates(event_id, id);
    `,
  },
];

export function migrate({ quiet = false } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version)
  );

  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
        m.version,
        m.name,
        new Date().toISOString(),
      ]);
      db.exec('COMMIT');
      if (!quiet) console.log(`[migrate] applied ${m.version}: ${m.name}`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${m.version} (${m.name}) failed: ${err.message}`);
    }
  }

  const current = get('SELECT MAX(version) AS v FROM schema_migrations');
  if (!quiet) console.log(`[migrate] schema at version ${current?.v ?? 0}`);
}

// `npm run migrate`
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate();
}
