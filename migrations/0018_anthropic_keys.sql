-- Migration number: 0018    2026-10-03
--
-- A user's own Anthropic API key, for tagging a board's pictures with
-- Claude (docs/boards.md, "Tagging with Claude") — a proof of concept.
--
-- The key is pasted on the settings page, kept here on the server, and sent
-- by the Worker with each request to the Anthropic API. It is NEVER sent
-- back to a browser: `GET /api/anthropic-key` answers whether one is kept
-- and its last four characters, nothing more. A table of its own rather
-- than a `meta` row beside the preferences, so a secret is not in the row
-- a future export or debug dump of `meta` would carry, and so that its name
-- says what is in it.
--
-- Stored as pasted, NOT encrypted at rest: D1 is the one database, reached
-- only through the Worker. Encrypting with a Worker secret would be the
-- next step before this leaves the proof-of-concept stage.
--
-- `calls_day` / `calls_today` are a daily fuse on the user's own bill, kept
-- the way an MCP token's are (0009): one UPDATE both reads the key and
-- counts the call, and a spent day matches no row.
--
-- Control-plane, like 0013 and 0014: D1 only, not part of the ladder the
-- browser store applies (src/data/corpus-schema.ts), reached through
-- `controlPlaneDriver`, never a `TenantDb`.

CREATE TABLE anthropic_keys (
  user_id     INTEGER PRIMARY KEY,  -- the verified GitHub id
  api_key     TEXT NOT NULL,        -- the key as pasted; never answered to a client
  last4       TEXT NOT NULL,        -- what the settings card shows
  updated_at  INTEGER NOT NULL,     -- ms epoch
  calls_day   INTEGER NOT NULL DEFAULT 0,  -- the UTC day `calls_today` counts
  calls_today INTEGER NOT NULL DEFAULT 0
);
