-- Migration number: 0019    2026-10-03
--
-- A daily count of an account's calls to Workers AI — the free provider
-- for tagging a board's pictures (docs/boards.md, "Tagging with Claude"),
-- behind the `cloudflareAi` flag.
--
-- The Anthropic path counts its day on the key's own row (0018); this path
-- has no key, and so no row, which is why the count has a table of its
-- own rather than a column borrowed from a row that may not exist. The
-- shape is the same: one statement counts the call and refuses a spent
-- day by matching nothing. It is a fuse on the instance's free allowance
-- (10,000 neurons a day, shared by every account on this Worker), not a
-- quota.
--
-- Control-plane, like 0013, 0014 and 0018: D1 only, not part of the ladder
-- the browser store applies (src/data/corpus-schema.ts), reached through
-- `controlPlaneDriver`, never a `TenantDb`.

CREATE TABLE ai_usage (
  user_id     INTEGER PRIMARY KEY,  -- the verified GitHub id
  calls_day   INTEGER NOT NULL,     -- the UTC day `calls_today` counts
  calls_today INTEGER NOT NULL
);
