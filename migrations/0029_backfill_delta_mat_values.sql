-- Migration number: 0029    2026-10-27
--
-- The cut-over of the read path to the per-key read model
-- (docs/event-sourcing.md, "Per-key events", "The cut-over"). From here on
-- a block's props are its rows of `delta_mat_values`, one per key, read back
-- as one JSON object of the live keys in sorted order (`nodePropsSql`,
-- src/data/node-props-sql.ts), and every reader of a block's props reads
-- them there. `nodes.props` STAYS, as a mirror: the projection writes it
-- from the keys beside every change, so a build from before the cut-over
-- reads it as it always did, and a revert loses nothing. A later migration
-- drops it, in a later PR, once the cut-over has run for a while. The
-- Worker writes `events_log` alone: the old `events` table stays as it is,
-- read only, and `events_log.seq` is the one order (the rows' `seq`, the
-- pull cursors, a moment named to `/at`).
--
-- ## The backfill
--
-- Every live key of every block's `props` that `delta_mat_values` does not
-- hold yet is written there, at the stamp the row holds for its props
-- (`stamps.props`), or on a row from before stamps the one its last event
-- derives (`updated_at`, `seq`), as `heldStamp` does. A tenant the Worker
-- has seeded (`delta_mat_values_seeded` in `meta`, 0028) gains nothing here:
-- its rows are the fold's already. A tenant never seeded — no write and no
-- verify since 0028 — gets its props as its rows said, one stamp per block,
-- and the Worker seeds its per-key stamps from the fold on its first write.
-- A key that does not match the pattern is left out, as 0028 left it out of
-- the log. A props column that is not a JSON object is read as none.

INSERT INTO delta_mat_values (user_id, block_id, key, value, hlc, seq, updated_at)
SELECT n.user_id, n.id, p.key, n.props -> p.fullkey,
  COALESCE(json_extract(n.stamps, '$.props'),
    printf('%015d-0000-seq:%015d', MIN(MAX(n.updated_at, 0), 999999999999999),
      COALESCE(n.seq, 0))),
  COALESCE(n.seq, 0), n.updated_at
FROM nodes n, json_each(
  CASE WHEN n.props IS NOT NULL AND json_valid(n.props) AND json_type(n.props) = 'object'
    THEN n.props ELSE '{}' END) AS p
WHERE p.type <> 'null'
  AND p.key GLOB '[A-Za-z_]*' AND p.key NOT GLOB '*[^A-Za-z0-9_.:-]*' AND length(p.key) <= 128
ON CONFLICT DO NOTHING;

