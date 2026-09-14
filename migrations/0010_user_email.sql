-- Migration number: 0010    2026-09-14
--
-- The account's email address, on its `users` row.
--
-- The primary verified address GitHub reports for the account — the same
-- address the sign-in callback has always fetched for the client — recorded
-- server-side against the verified id. It is written only by the server:
-- the sign-in callback now runs the tenancy resolver itself
-- (worker/handlers/tenancy.ts) and records the address as it provisions or
-- refreshes the row, so an admitted account has it before its first API
-- request. The API path verifies `/user` alone and leaves the stored value
-- alone.
--
-- What it is for: addressing another user without a directory. Sharing
-- (docs/sharing.md) names a grantee by the address the owner types, and
-- resolves it to a GitHub id through this column at read time — so nothing
-- in the app ever lists users or confirms whether an address belongs to one.
--
-- NULL on every row that predates this migration. There is no backfill:
-- an account picks its address up on its next sign-in, and the handful of
-- rows that exist today are filled in by hand.
--
-- Control-plane, like 0003 and 0007: D1 only, not part of the ladder the
-- browser store applies (src/data/corpus-schema.ts).

ALTER TABLE users ADD COLUMN email TEXT;

-- "which id does this address belong to" — the lookup sharing resolves a
-- grantee through.
CREATE INDEX users_email ON users (email);
