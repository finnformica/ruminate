-- Migration number: 0027    2026-10-21
--
-- A View saves a whole stack of frames (docs/graph-walk.md, "Views save
-- stacks"). `root_id`, `filter` and `sort` stay the top frame's; `stack`
-- holds the rest in the frame encoding: the frames below the top, base first,
-- and the top frame's pivots and sections-only. NULL is a one-frame View,
-- which is every View before this migration.
--
-- One nullable column and no backfill, on both shapes: the local store's
-- schema ladder adds the same column (`LOCAL_V13_SQL`,
-- src/data/corpus-schema.ts). `stack` is a field of the view entity like the
-- others: an event may set it, and it resolves by stamp (`stamps.stack`). A
-- row's `stamps` without a `stack` key is a row no event has set it on yet,
-- and any event that names it wins (`heldStamp`, worker/handlers/event-log.ts).

ALTER TABLE views ADD COLUMN stack TEXT;
