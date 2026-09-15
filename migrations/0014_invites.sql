-- Migration number: 0014    2026-09-15
--
-- Invite links; the allowlist retires.
--
-- Admission used to be an `allowlist` row keyed by GitHub id, written by hand
-- with `wrangler d1 execute` — which meant asking the person for their GitHub
-- account before they could sign in. An **invite** turns that around: the
-- admin mints a link, sends it, and whoever opens it and signs in with GitHub
-- is admitted. The Worker learns their id (and address) from the sign-in, so
-- nothing has to be asked for up front.
--
-- An invite is single-use and expiring. Like an MCP token (0007) the secret
-- is NOT here: `token_hash` is the SHA-256 of the token in the link, and the
-- token itself is shown once, at mint. Redemption looks the hash up (the
-- unique index), checks it is live, and records who took it — the row is the
-- audit trail of who let whom in.
--
-- Control-plane, like 0003, 0007, 0012 and 0013: D1 only, not part of the
-- ladder the browser store applies (src/data/corpus-schema.ts), reached
-- through `controlPlaneDriver`, never a `TenantDb`.

DROP TABLE allowlist;

CREATE TABLE invites (
  id          TEXT PRIMARY KEY,   -- `inv_<20 chars>`; the public handle, safe to show
  token_hash  TEXT NOT NULL,      -- SHA-256(token), lowercase hex. The secret is never stored.
  created_by  INTEGER NOT NULL,   -- the admin's verified GitHub id
  note        TEXT,               -- what the admin called it ("for Ada")
  created_at  INTEGER NOT NULL,   -- ms epoch
  expires_at  INTEGER NOT NULL,   -- ms epoch; an invite always expires
  redeemed_at INTEGER,            -- ms epoch; non-NULL = used, by `redeemed_by`
  redeemed_by INTEGER,            -- the verified GitHub id admitted through it
  revoked_at  INTEGER             -- ms epoch; non-NULL = dead, kept for the audit trail
);

-- The redemption path: one seek, by hash. UNIQUE so two invites can never
-- share a secret.
CREATE UNIQUE INDEX invites_hash ON invites (token_hash);

-- The admin page: "invites, newest first".
CREATE INDEX invites_created ON invites (created_at);
