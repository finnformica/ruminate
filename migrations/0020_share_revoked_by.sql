-- Migration number: 0020    2026-10-06
--
-- Who ended a share (docs/sharing.md).
--
-- Until now only the owner could retire a share row, so `revoked_at` alone
-- said all there was to say. The person a share is for can now LEAVE it —
-- the same row retired, from the other side — and the owner's Sharing page
-- should say which it was: a share they revoked, or one the grantee left.
-- Either way the row is kept, for the audit trail, and a share that is to
-- come back is a new share.
--
-- Control-plane, like 0012 and 0017: D1 only, not part of the ladder the
-- browser store applies (src/data/corpus-schema.ts).

ALTER TABLE shares ADD COLUMN revoked_by TEXT
  CHECK (revoked_by IS NULL OR revoked_by IN ('owner', 'grantee'));

-- Every share retired before this column existed was retired by its owner:
-- that was the only hand that could.
UPDATE shares SET revoked_by = 'owner' WHERE revoked_at IS NOT NULL AND revoked_by IS NULL;
