-- Migration number: 0004    2026-08-31
--
-- Corpus tables come back to D1, scoped by column, with soft deletes
-- (docs/multi-tenant-design.md "Decision reversal", docs/graph-schema-v2.md).
--
-- Two changes, one rebuild:
--
-- 1. **Tenancy by column.** Every corpus row gains `user_id` (the verified
--    GitHub id) and every primary key and index leads with it. SQLite cannot
--    ALTER a primary key, so each table is rebuilt: create the new shape, copy
--    the existing single-tenant rows stamping the owner's id, drop the old,
--    rename. The pre-DO rows still sitting in this database ARE the owner's
--    data — they are preserved, not dropped.
-- 2. **Soft deletes.** `nodes` and `link` gain `deleted_at` (NULL = live).
--    Nothing is hard-deleted by the app any more: a delete stamps the column,
--    and reads discard tombstoned rows at read time (the rollup skips a link
--    whose either endpoint is tombstoned). Links to deleted nodes are RETAINED
--    so a future restore can put a node back where it was.
--
-- `meta` becomes per-tenant too — each tenant has its own `replica_cursor`,
-- `schema_version`, and `data_version`.
--
-- The foreign keys `link` carried in 0002 are dropped deliberately: nothing is
-- hard-deleted, so `ON DELETE CASCADE` can never fire; retaining links to
-- tombstoned nodes is the design; the app already cleans link rows explicitly
-- (`planReplicaPut`); and a composite FK across the tenant key would buy
-- nothing but rebuild pain.
--
-- Unlike 0001/0002 this file is D1-only. The browser store keeps the
-- single-tenant shape (one user per browser profile) and gains only
-- `deleted_at` — that divergence is the documented seam in
-- `src/data/corpus-schema.ts`, which applies this file in "columns" mode and
-- an equivalent ALTER-only step in "single" mode.
--
-- Table order matters: `link` is rebuilt FIRST so that by the time `nodes` is
-- dropped no foreign key points at it.

-- The owner's tenant id: the same literal 0003 seeds into `allowlist`, and the
-- value of `ALLOWED_GITHUB_ID` in wrangler.jsonc. All three must agree; 0003
-- hardcodes it for the same reason (SQL cannot read a Worker var).

CREATE TABLE link_v3 (
  user_id INTEGER NOT NULL,
  source_id TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'child',  -- 'child' = containment; room for more
  sort_key TEXT NOT NULL,    -- fractional index; sibling order under a source
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,        -- NULL = live; a tombstone is retained, not traversed
  PRIMARY KEY (user_id, source_id, destination_id, kind)
);

INSERT INTO link_v3 (user_id, source_id, destination_id, kind, sort_key, updated_at, deleted_at)
  SELECT 42536816, source_id, destination_id, kind, sort_key, updated_at, NULL FROM link;

DROP TABLE link;
ALTER TABLE link_v3 RENAME TO link;

CREATE TABLE nodes_v3 (
  user_id INTEGER NOT NULL,
  id TEXT NOT NULL,          -- blk_ ids as-is; page nodes use the note id
  type TEXT NOT NULL,        -- type registry in docs/graph-schema-v2.md; no CHECK
  text TEXT NOT NULL,        -- marker-free content; for pages, the title
  props TEXT,                -- JSON or NULL; pages: frontmatter; code: language
  updated_at INTEGER NOT NULL,  -- ms epoch, drives LWW + since-cursor pulls
  deleted_at INTEGER,        -- NULL = live; tombstoned rows never render
  PRIMARY KEY (user_id, id)
);

INSERT INTO nodes_v3 (user_id, id, type, text, props, updated_at, deleted_at)
  SELECT 42536816, id, type, text, props, updated_at, NULL FROM nodes;

DROP TABLE nodes;
ALTER TABLE nodes_v3 RENAME TO nodes;

CREATE TABLE meta_v3 (
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

INSERT INTO meta_v3 (user_id, key, value) SELECT 42536816, key, value FROM meta;

DROP TABLE meta;
ALTER TABLE meta_v3 RENAME TO meta;

-- Every index leads with the tenant key, so a scan can never wander out of one
-- tenant's partition even before the WHERE clause is considered.

-- "all my pages", "all my todos".
CREATE INDEX nodes_tenant_type ON nodes (user_id, type);
-- Since-cursor pulls.
CREATE INDEX nodes_tenant_updated ON nodes (user_id, updated_at);
-- Downstream: a node's children in order.
CREATE INDEX link_tenant_source ON link (user_id, source_id, kind, sort_key);
-- Upstream: who contains this node (multi-parent lookup, delete-rescue).
CREATE INDEX link_tenant_destination ON link (user_id, destination_id);
-- Since-cursor pulls read changed link rows the same way as changed nodes.
CREATE INDEX link_tenant_updated ON link (user_id, updated_at);

UPDATE meta SET value = '3' WHERE key = 'schema_version';
