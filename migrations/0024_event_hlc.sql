-- Migration number: 0024    2026-10-20
--
-- Each event's stamp: a hybrid logical clock, the writer's wall clock in ms,
-- a counter and the writer's device, encoded as one fixed-width string so two
-- stamps compare as strings (src/data/hlc.ts, docs/event-only-sync.md).
--
-- One nullable column and no backfill. The log is append-only, so no event
-- already in it is rewritten: an event with no stamp gets one derived when it
-- is read (`eventStamp`, src/data/events.ts), from its `at` and its `seq`.
-- ALTER TABLE does not fire the triggers that refuse an UPDATE.
--
-- The stamp is stored and served. Nothing resolves by it yet: `seq` still
-- orders the projection.

ALTER TABLE events ADD COLUMN hlc TEXT;
