-- Migration number: 0015    2026-09-20
--
-- Views: the entrypoints into the graph, as rows rather than as node props.
--
-- A **view** is a way in: a node to start at (`root_id`), what of its subgraph
-- to keep (`filter`), how to lay that out (`sort`), and whether it earns a
-- place in the sidebar (`pinned`, ordered by `sort_key`). A note is the view
-- rooted at a page node; a focused block is the view rooted at that block.
-- Nothing about it is derivable from the graph, which is what makes it a table
-- of its own rather than a projection — and why the v1 `notes`/`blocks` tables
-- dropped in 0002 are no precedent: those were projections of content, and
-- this is not.
--
-- ## Why not node props
--
-- `pinned`, `filter` and `sort` lived in the node's `props` JSON until now.
-- Two things that shape cannot express, both of which are the point:
--
-- * **Someone else's note.** A share hands you a node the owner owns; its
--   props are theirs, and the replica refuses a push that touches them
--   (`worker/handlers/shares.ts`). So there was nowhere to record that YOU
--   pinned it. Keyed by `user_id` here, a view is the viewer's own row about
--   a node that is not.
-- * **Order.** The sidebar's order is a property of the list, not of any node
--   in it; a sort key per node's props is cross-row data hidden in per-row
--   blobs. `sort_key` is the same fractional index `link` already uses for
--   sibling order, so reordering writes one row.
--
-- Structured columns also give the three fields types and let the sidebar ask
-- for what it wants, instead of scanning every node in the corpus and
-- substring-testing its JSON for `"pinned"`.
--
-- ## The sequence spans three tables now
--
-- `seq` (0005) is assigned per tenant from the maximum across every corpus
-- table, so ONE cursor covers them all. Adding a table means every `seq`
-- expression in `planReplicaPut` must consider it too — otherwise a node write
-- could take a number a view already holds and an incremental pull would step
-- over it. The expression lives in one constant there for that reason.
--
-- The keys themselves are retired by 0016, not here. Backfilling and
-- retiring in one step would mean a window where the replica had removed the
-- props but the clients still reading them had not been replaced — every pin
-- would vanish until the deploy caught up. 0015 is additive and safe on its
-- own; 0016 ships with the client that reads the table.
--
-- `id` is minted per view rather than being the root's id, so a node may
-- carry several views later without another migration. The backfill below
-- uses the root's id, which keeps it deterministic and re-runnable.
--
-- `root_id` carries no foreign key, deliberately, exactly as link targets have
-- had none since 0001: a view may point at a node belonging to another tenant
-- (a share), which no key within this tenant's partition could express.

CREATE TABLE views (
  user_id    INTEGER NOT NULL,
  id         TEXT NOT NULL,        -- minted; several per root are allowed
  root_id    TEXT NOT NULL,        -- the node this enters the graph at
  filter     TEXT,                 -- query language; NULL = the whole subgraph
  sort       TEXT,                 -- `text:desc`; NULL = document order
  pinned     INTEGER NOT NULL DEFAULT 0,  -- 0/1; listed in the sidebar
  sort_key   TEXT,                 -- fractional index; NULL = unordered yet
  updated_at INTEGER NOT NULL,     -- ms epoch, per-row LWW
  deleted_at INTEGER,              -- tombstone; a delete only travels if it does
  seq        INTEGER NOT NULL DEFAULT 0,  -- server-assigned, shared with nodes/link
  PRIMARY KEY (user_id, id)
);

-- "the view(s) rooted at this node" — the note page's lookup, once per open.
CREATE INDEX views_tenant_root ON views (user_id, root_id);
-- "what is pinned, in order" — the sidebar's whole query.
CREATE INDEX views_tenant_pinned ON views (user_id, pinned, sort_key);
-- The since-cursor's scan, as `nodes` and `link` have.
CREATE INDEX views_tenant_seq ON views (user_id, seq);

-- Backfill: one view per node that carried any of the three keys. The row's
-- id is the root's, so running this twice writes the same rows. `sort_key` is
-- left NULL rather than invented here — the client keeps its existing order
-- until something is dragged, and assigns keys then.
INSERT INTO views (user_id, id, root_id, filter, sort, pinned, sort_key, updated_at, seq)
SELECT
  n.user_id,
  n.id,
  n.id,
  json_extract(n.props, '$.filter'),
  json_extract(n.props, '$.sort'),
  CASE WHEN json_extract(n.props, '$.pinned') = 1 THEN 1 ELSE 0 END,
  NULL,
  n.updated_at,
  0
FROM nodes n
WHERE n.deleted_at IS NULL
  AND n.props IS NOT NULL
  AND json_valid(n.props)
  AND (
    json_extract(n.props, '$.pinned') IS NOT NULL
    OR json_extract(n.props, '$.filter') IS NOT NULL
    OR json_extract(n.props, '$.sort') IS NOT NULL
  )
ON CONFLICT (user_id, id) DO NOTHING;
