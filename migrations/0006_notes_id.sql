-- Migration number: 0006    2026-09-11
--
-- Every block remembers the note it was written in: `notes_id`.
--
-- A block belongs to a note only by being reachable from the note's page node
-- through child links. Until now that was the whole story, so a block whose
-- last link was removed — by deleting the block above it — was collected:
-- nothing could reach it, nothing could show it, so the delete cascaded down
-- through it. `notes_id` gives every block a note of its own regardless of
-- links, so a block that has fallen out of reach still has somewhere to be
-- shown: that note's **Unassigned** basket (docs/graph-schema-v2.md,
-- "Delete"). Deleting a block therefore no longer cascades — its children are
-- simply unlinked from it and turn up in the basket, where they can be pasted
-- back into the outline or deleted deliberately.
--
-- Set once, when the block is created, to the page being edited. Linking the
-- block into other notes never changes it (it is where the block was born,
-- not where it lives). Pages have none. NULL on rows older than this
-- migration until the backfill below fills it in.
--
-- Backfill: give every live block the first page (by id) that reaches it
-- through live child links. A recursive CTE walks every tenant's pages at
-- once; UNION (not UNION ALL) discards repeated rows, which is what makes the
-- recursion terminate on a graph that holds a loop. A block no page reaches
-- stays NULL — nothing to show it under.
--
-- The browser store's ladder (src/data/corpus-schema.ts) adds the column
-- without a backfill: the local store is a cache of this corpus and re-pulls
-- (CACHE_GENERATION, src/data/database-mode.ts), so the ids computed here
-- arrive with the rows.

ALTER TABLE nodes ADD COLUMN notes_id TEXT;

-- "this note's unassigned blocks", leading with the tenant key like every
-- other index here.
CREATE INDEX nodes_tenant_notes ON nodes (user_id, notes_id);

WITH RECURSIVE reach (user_id, page, node) AS (
  SELECT l.user_id, l.source_id, l.destination_id
    FROM link l
    JOIN nodes p ON p.user_id = l.user_id AND p.id = l.source_id
   WHERE p.type = 'page' AND p.deleted_at IS NULL
     AND l.kind = 'child' AND l.deleted_at IS NULL
  UNION
  SELECT r.user_id, r.page, l.destination_id
    FROM reach r
    JOIN link l ON l.user_id = r.user_id AND l.source_id = r.node
   WHERE l.kind = 'child' AND l.deleted_at IS NULL
)
UPDATE nodes
   SET notes_id = (SELECT MIN(page) FROM reach
                   WHERE reach.user_id = nodes.user_id AND reach.node = nodes.id)
 WHERE type != 'page' AND notes_id IS NULL
   AND EXISTS (SELECT 1 FROM reach
                WHERE reach.user_id = nodes.user_id AND reach.node = nodes.id);

UPDATE meta SET value = '4' WHERE key = 'schema_version';
