-- Migration number: 0021    2026-10-06
--
-- Every note and board has a view row, and the row is what lists it.
--
-- Until now the Views list was every note, row or no row, plus the blocks
-- that had a row: a note's row said only how it opens and where it sits, and
-- `pinned` (0015) was written for blocks alone. Now a view row with
-- `pinned = 1` is what makes ANY node an entry point into the graph — a note,
-- a board, a block alike — and the type only says how the node draws
-- (docs/metadata.md, "Views"). A note is created with such a row, can be
-- removed from Views (`pinned = 0`) and added back, and the next change
-- links boards inside notes that are made WITHOUT one, so they are not
-- listed. This backfill gives every note and board that is there already the
-- row it would have been created with, so nothing leaves the list.
--
-- Ships WITH the client that reads the rows this way. `npm run deploy` runs
-- this BEFORE `wrangler deploy`, so between the two the old code runs
-- against the new rows: it lists every note regardless and ignores
-- `pinned` on a note's row, so it shows exactly what it showed.
--
-- ## Delivery: `seq` is advanced
--
-- Rows replicate by `seq` (0005): a client pulls `seq > cursor`, and the
-- sequence is per tenant across all three tables. A backfilled row with
-- `seq = 0` would never reach a device that already holds a cursor, and a
-- device pulling from zero would take it but could then be handed, on a later
-- incremental pull, nothing of what this file wrote after its cursor passed
-- it. So every row this file writes or rewrites takes a value strictly above
-- the tenant's current maximum, in 0008's register: the per-tenant maximum
-- is materialized into a scratch table FIRST (an `UPDATE` must not read the
-- column it is writing), and each row adds its own `rowid`, which is distinct
-- within a table. Two steps, two maxima: the rows rewritten by the first step
-- raise the maximum the second step's rows are placed above, so no value is
-- taken twice. `CACHE_GENERATION` 8 (src/data/database-mode.ts) makes every
-- client pull from zero besides, so the rows are on screen at the first boot
-- rather than after the first since-pull; a new device, and every pull after
-- the first, rely on the sequence alone.
--
-- ## Intent: `updated_at`
--
-- An INSERTED row is stamped with its node's `updated_at`, as 0015 stamped
-- its backfill: the row is no claim about when the view was last meant, so a
-- row a device wrote for the same note while apart (a saved filter, a drag)
-- carries a newer stamp and wins the upsert, as it should. A REWRITTEN row
-- moves by one, as 0016 and 0020 do, so the pinned version is the newer one
-- and a stale push of the old row cannot put `pinned = 0` back over it.
--
-- Re-runnable: a live row rooted at a note is left alone once it is pinned,
-- and a note with a live row is not inserted again. A partially-applied run
-- is simply run again: the leading DROP clears the scratch table.

-- Step 1: a live row rooted at a live note or board that is not pinned —
-- 0015's backfill of a note that had saved a filter or a sort, or a row a
-- drag minted for its place — is pinned, and takes a fresh sequence value.
DROP TABLE IF EXISTS note_views_seq_base;

CREATE TABLE note_views_seq_base AS
  SELECT user_id, MAX(seq) AS base
    FROM (SELECT user_id, seq FROM nodes
          UNION ALL
          SELECT user_id, seq FROM link
          UNION ALL
          SELECT user_id, seq FROM views)
   GROUP BY user_id;

UPDATE views
   SET pinned = 1,
       updated_at = updated_at + 1,
       seq = (SELECT base FROM note_views_seq_base b WHERE b.user_id = views.user_id) + views.rowid
 WHERE pinned = 0
   AND deleted_at IS NULL
   AND EXISTS (
     SELECT 1 FROM nodes n
      WHERE n.user_id = views.user_id
        AND n.id = views.root_id
        AND n.type IN ('note', 'board')
        AND n.deleted_at IS NULL
   );

-- Step 2: a live note or board with no live row gets one — pinned, saving
-- nothing, unplaced (`sort_key` NULL: the list keeps its order until
-- something is dragged, as 0015 left it). The row's id is the root's
-- (src/data/views.ts), so a tombstone under that id — a note whose row was
-- cleared, or one deleted and restored — is revived in place rather than
-- conflicted with: cleared as a fresh row would be, stamped past the
-- tombstone, and given the fresh sequence value.
DROP TABLE IF EXISTS note_views_seq_base;

CREATE TABLE note_views_seq_base AS
  SELECT user_id, MAX(seq) AS base
    FROM (SELECT user_id, seq FROM nodes
          UNION ALL
          SELECT user_id, seq FROM link
          UNION ALL
          SELECT user_id, seq FROM views)
   GROUP BY user_id;

INSERT INTO views (user_id, id, root_id, filter, sort, pinned, sort_key, updated_at, deleted_at, seq)
SELECT
  n.user_id,
  n.id,
  n.id,
  NULL,
  NULL,
  1,
  NULL,
  n.updated_at,
  NULL,
  (SELECT base FROM note_views_seq_base b WHERE b.user_id = n.user_id) + n.rowid
FROM nodes n
WHERE n.type IN ('note', 'board')
  AND n.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM views v
     WHERE v.user_id = n.user_id
       AND v.root_id = n.id
       AND v.deleted_at IS NULL
  )
ON CONFLICT (user_id, id) DO UPDATE SET
  filter = NULL,
  sort = NULL,
  pinned = 1,
  sort_key = NULL,
  updated_at = MAX(views.updated_at + 1, excluded.updated_at),
  deleted_at = NULL,
  seq = excluded.seq
WHERE views.deleted_at IS NOT NULL;

DROP TABLE note_views_seq_base;
