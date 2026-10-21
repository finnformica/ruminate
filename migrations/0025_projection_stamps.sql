-- Migration number: 0025    2026-10-21
--
-- The projections resolve by stamp (docs/event-only-sync.md, The server). Each
-- field of a row is a last-writer-wins register on the stamp of the event that
-- set it, and `stamps` holds those stamps: a JSON object with one key per
-- field and one for liveness (`alive`), for example
-- `{"type":"…","text":"…","props":"…","notes_id":"…","alive":"…"}`.
-- `legacy` names the last `seq` the row was projected by the old rule, in
-- `seq` order, so `verify` can fold that part of the log the same way.
--
-- One nullable column per table and no backfill. An empty `stamps` is a row
-- no event has touched since this migration: each of its fields resolves by
-- the stamp derived from the row's `updated_at` and `seq` (`eventStamp`,
-- src/data/events.ts), and the first append that touches it writes them all.
-- The D1 projection only: the browser's tables do not resolve by stamp, and
-- they retire (docs/event-only-sync.md, ES-11).

ALTER TABLE nodes ADD COLUMN stamps TEXT;
ALTER TABLE link ADD COLUMN stamps TEXT;
ALTER TABLE views ADD COLUMN stamps TEXT;
