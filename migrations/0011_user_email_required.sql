-- Migration number: 0011    2026-09-15
--
-- `users.email` becomes mandatory.
--
-- 0010 added the column nullable, because the rows that existed then had no
-- address on record. They have since been filled in by hand, and every new
-- row is written by the sign-in callback with the address GitHub reports
-- (worker/handlers/tenancy.ts) — so there is no longer any row without one,
-- and there is no path that could create one. The schema now says so.
--
-- SQLite cannot add a NOT NULL constraint to an existing column, so the table
-- is rebuilt, the way 0004 rebuilt the corpus tables: create the new shape,
-- copy the rows, drop the old, rename. The copy FAILS if any row still has a
-- NULL address — deliberately: that is the one condition this migration must
-- not be applied under, and a loud failure beats a row silently invented.
-- Fill the address in first (`UPDATE users SET email = … WHERE github_id = …`).
--
-- Control-plane, like 0003 and 0010: D1 only, not part of the ladder the
-- browser store applies (src/data/corpus-schema.ts).

CREATE TABLE users_v2 (
  github_id    INTEGER PRIMARY KEY,             -- the tenant key (verified GitHub id)
  login        TEXT NOT NULL,                   -- display/debug only, never an address
  name         TEXT,
  status       TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'blocked'
  created_at   INTEGER NOT NULL,                -- ms epoch
  created_by   TEXT NOT NULL DEFAULT 'signup',  -- 'signup' | 'allowlist' | 'admin'
  last_seen_at INTEGER,
  email        TEXT NOT NULL                    -- primary verified GitHub address, lowercased
);

INSERT INTO users_v2 (github_id, login, name, status, created_at, created_by, last_seen_at, email)
  SELECT github_id, login, name, status, created_at, created_by, last_seen_at, email FROM users;

DROP TABLE users;
ALTER TABLE users_v2 RENAME TO users;

-- Dropped with the old table; "which id does this address belong to" is the
-- lookup sharing resolves a grantee through.
CREATE INDEX users_email ON users (email);
