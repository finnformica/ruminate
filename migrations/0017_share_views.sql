-- Migration number: 0017    2026-09-21
--
-- A share is a view shared with someone (docs/sharing.md, docs/metadata.md).
--
-- Until now a share named its own root (`root_ids`, a JSON array that only
-- ever held one id — the dialog shares one note or block at a time). The
-- root, the filter and the sort are what a VIEW is (migrations/0015), and a
-- share is the owner's view of a node, handed to someone else with verbs
-- attached. So the share now names the view, `view_id`, and everything about
-- what is shared — where it starts, what of it to keep, how to lay it out —
-- is read from the owner's `views` row at request time. The owner changes
-- the share by changing their view; the row here holds only the grant: who,
-- which view, which verbs, and when it was revoked.
--
-- `view_id` is the id of a row in `views` under `(owner_id, id)`. The view's
-- id is its root's id (src/data/views.ts), which is what the backfill relies
-- on: the first (and only) root becomes the view id, and a view row is
-- written for it where the owner has none yet — unpinned, unfiltered, so it
-- changes nothing the owner sees. A view row is never removed, only
-- tombstoned, so the reference cannot dangle: a tombstoned view still names
-- its root, and the share serves the whole subtree in document order until
-- the owner saves a view again, which revives the same row.
--
-- No foreign key constraint, as nowhere else in this database: the target
-- is in another tenant's partition of a corpus table, and the reference is
-- resolved by the handler under the owner's tenant handle, never by SQLite.
--
-- The copy FAILS on a share naming more than one root — deliberately, as
-- 0011 fails on a row it must not guess about. None exists (the client never
-- made one); if one did, split it into shares by hand first.
--
-- Control-plane, like 0012: D1 only, not part of the ladder the browser
-- store applies (src/data/corpus-schema.ts) — except that its second half
-- writes `views` rows, which ARE corpus rows; they carry `seq` 0, like the
-- 0015 backfill, because an owner's devices need not pull an empty view.

CREATE TABLE shares_v2 (
  id            TEXT PRIMARY KEY,     -- `shr_<20 chars>`; the public handle
  owner_id      INTEGER NOT NULL,     -- the verified GitHub id whose view this is
  grantee_email TEXT NOT NULL
    CHECK (grantee_email = lower(trim(grantee_email)) AND grantee_email LIKE '%_@_%.__%'
           AND grantee_email NOT LIKE '% %'),
  -- The owner's view (`views.id` under `views.user_id = owner_id`): its
  -- root is what is shared, its filter and sort how the grantee opens it.
  view_id       TEXT NOT NULL,
  permissions   TEXT NOT NULL,        -- 'read[,write[,delete]]'; `read` always present
  created_at    INTEGER NOT NULL,     -- ms epoch
  revoked_at    INTEGER               -- ms epoch; non-NULL = dead, kept for the audit trail
);

INSERT INTO shares_v2 (id, owner_id, grantee_email, view_id, permissions, created_at, revoked_at)
SELECT
  id,
  owner_id,
  grantee_email,
  CASE WHEN json_array_length(root_ids) = 1 THEN json_extract(root_ids, '$[0]') END,
  permissions,
  created_at,
  revoked_at
FROM shares;

DROP TABLE shares;
ALTER TABLE shares_v2 RENAME TO shares;

CREATE INDEX shares_owner ON shares (owner_id, created_at);
CREATE INDEX shares_grantee ON shares (grantee_email, created_at);

-- Every live share's view exists: where the owner never saved one, an empty
-- row rooted at what was shared. Re-runnable — an existing row is kept.
INSERT INTO views (user_id, id, root_id, filter, sort, pinned, sort_key, updated_at, seq)
SELECT s.owner_id, s.view_id, s.view_id, NULL, NULL, 0, NULL, s.created_at, 0
FROM shares s
WHERE s.revoked_at IS NULL
ON CONFLICT (user_id, id) DO NOTHING;
