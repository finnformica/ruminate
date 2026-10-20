-- Migration number: 0026    2026-10-20
--
-- The event log is strictly append-only (docs/event-only-sync.md, Strictly
-- append-only).
--
-- 0023 refused every UPDATE on `events`, and every DELETE unless the tenant
-- was named in `event_purges`: a door left open for erasing an account. No
-- code ever opened it. This closes it: the trigger now refuses every DELETE,
-- for every tenant, and the table goes.
--
-- A delete and a restore are events; nothing is ever purged. The cost, which
-- the owner accepted on 2026-10-20: an account cannot be erased from the log,
-- and text pasted by mistake stays in its history. Erasure, if it is ever
-- needed, is a new design (for example, a key per tenant that can be
-- destroyed), not a reopened door.
--
-- The trigger goes first: the old one reads `event_purges`.

DROP TRIGGER events_no_delete;

CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

DROP TABLE event_purges;
