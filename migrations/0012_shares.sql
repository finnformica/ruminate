-- Migration number: 0012    2026-09-14
--
-- Sharing a subgraph of notes with another user (docs/sharing.md).
--
-- A share is a **scoped grant**: a control-plane row naming an owner, the
-- person it is for, a set of root notes in the owner's corpus, and the verbs
-- the grantee may use. The data never moves — the grantee reads and writes a
-- *slice* of the owner's partition, and the slice is computed on every
-- request as the reachability closure downstream of the roots over live
-- child links. A block added under a shared note tomorrow is in the share
-- tomorrow; a block unlinked from it leaves the share the moment it leaves
-- the note. That is what "permissions cascade downstream" means here.
--
-- **The grantee is named by email, not by GitHub id.** The owner types an
-- address into a text box; nothing in the app lists other users or confirms
-- whether an address belongs to one. The address is stored lowercased and is
-- resolved to a GitHub id only when the grantee's own verified session asks
-- for their shares — via `users.email` (migrations/0010, mandatory since
-- 0011), the PRIMARY verified address GitHub reports for the account,
-- recorded by the sign-in callback. An address nobody has signed in with is
-- simply a share nobody can see yet.
--
-- `root_ids` holds node ids: a note (shared from its menu) or a block
-- (shared from its right-click menu) — the closure walk is the same either
-- way.
--
-- Control-plane, like 0003 and 0007: D1 only, not part of the ladder the
-- browser store applies (src/data/corpus-schema.ts), reached through
-- `controlPlaneDriver`, never a `TenantDb`. The owner's rows are read and
-- written through a `TenantDb` minted for the owner from `owner_id` — the
-- one place a request handles a tenant handle that is not the caller's own,
-- and it is minted from this row and from nothing the caller sent.

CREATE TABLE shares (
  id            TEXT PRIMARY KEY,     -- `shr_<20 chars>`; the public handle
  owner_id      INTEGER NOT NULL,     -- the verified GitHub id whose notes these are
  -- Lowercased; resolved through users.email at read time, under the same
  -- CHECK that column carries (migrations/0011), so the two can only ever
  -- differ by being different addresses.
  grantee_email TEXT NOT NULL
    CHECK (grantee_email = lower(trim(grantee_email)) AND grantee_email LIKE '%_@_%.__%'
           AND grantee_email NOT LIKE '% %'),
  -- JSON array of note ids in the owner's corpus. Never empty: the create
  -- endpoint refuses an empty list rather than storing a share over nothing.
  root_ids      TEXT NOT NULL,
  -- Comma-separated subset of 'read,write,delete', in that order; `read` is
  -- always present, and today it is all there is: shares are read-only. The
  -- column is here so write and delete can arrive without a migration. A
  -- string rather than three columns because the set is read whole on every
  -- request and never queried by member.
  permissions   TEXT NOT NULL,
  created_at    INTEGER NOT NULL,     -- ms epoch
  revoked_at    INTEGER               -- ms epoch; non-NULL = dead, kept for the audit trail
);

-- "the shares I have given", newest first.
CREATE INDEX shares_owner ON shares (owner_id, created_at);
-- "the shares addressed to me", newest first.
CREATE INDEX shares_grantee ON shares (grantee_email, created_at);
