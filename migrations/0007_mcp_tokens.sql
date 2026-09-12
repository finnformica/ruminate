-- Migration number: 0007    2026-09-12
--
-- MCP access tokens: the grants an agent holds (docs/mcp-server.md).
--
-- The MCP endpoint (`POST /mcp`, worker/handlers/mcp.ts) is reached by agents,
-- not by browsers, so it cannot use the session credentials the rest of the
-- app does: there is no cookie jar to hold `gh_refresh`, and handing an agent
-- a GitHub access token would hand it the whole GitHub account. A token here
-- is instead a **grant minted by the user in Settings**, and it carries the
-- only three things the MCP server needs to know:
--
--   1. WHOSE corpus it reads (`user_id`, a verified GitHub id — the same
--      tenant key every corpus row carries);
--   2. WHAT it may do (`permissions`: read, write, delete);
--   3. WHICH notes it may touch (`note_ids`, or NULL for every note).
--
-- That triple is the whole answer to "a rogue agent could…": an agent holding
-- a read-only grant over one note cannot see a second note, cannot write, and
-- cannot delete, however it is prompted.
--
-- **The secret is not here.** `token_hash` is the SHA-256 of the token, hex;
-- the token itself is shown once, at mint, and never stored. A leak of this
-- table is a leak of nobody's access. Lookup is BY the hash (the unique index
-- below), so the comparison is the index seek — there is no string compare to
-- get wrong.
--
-- Like 0003 this file is D1-only: it is control-plane, not corpus, so it is
-- NOT part of the ladder the browser store applies (src/data/corpus-schema.ts)
-- and it is reached through `controlPlaneDriver`, never a `TenantDb`.

CREATE TABLE mcp_tokens (
  id           TEXT PRIMARY KEY,     -- `mcp_<20 chars>`; the public handle, safe to show
  user_id      INTEGER NOT NULL,     -- the verified GitHub id this grant belongs to
  token_hash   TEXT NOT NULL,        -- SHA-256(token), lowercase hex. The secret is never stored.
  name         TEXT NOT NULL,        -- what the user called it ("Claude Desktop")
  -- Comma-separated subset of 'read,write,delete', in that order. A string
  -- rather than three columns because the set is read whole on every request
  -- and never queried by member.
  permissions  TEXT NOT NULL,
  -- JSON array of page node ids, or NULL for "every note". An empty array is
  -- NOT the same thing: it is a grant over no notes at all, which the mint
  -- endpoint refuses rather than storing.
  note_ids     TEXT,
  created_at   INTEGER NOT NULL,     -- ms epoch
  expires_at   INTEGER,              -- ms epoch; NULL = no expiry
  last_used_at INTEGER,              -- ms epoch, refreshed at most hourly
  revoked_at   INTEGER               -- ms epoch; non-NULL = dead, kept for the audit trail
);

-- The authentication path: one seek, by hash. UNIQUE so two grants can never
-- share a secret (and so a hash collision is a write error, not a silent
-- widening of someone's access).
CREATE UNIQUE INDEX mcp_tokens_hash ON mcp_tokens (token_hash);

-- The management path: "my tokens, newest first".
CREATE INDEX mcp_tokens_user ON mcp_tokens (user_id, created_at);
