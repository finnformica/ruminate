-- Migration number: 0018    2026-09-21
--
-- The event log: every change to a block, a link or a view, as an appended
-- row, in one total order per tenant (docs/event-sourcing.md).
--
-- Until now the corpus tables WERE the data, written last-writer-wins: a row
-- holds its final state and nothing else, so an overwrite destroys what it
-- replaces. The incident of 2026-09-19 is what that costs — three blocks of a
-- tester's notes were emptied by ordinary edits, and the only copy of the
-- text was D1 Time Travel, read by rolling production back for ten seconds.
--
-- With this table the relationship inverts. `events` is the truth; `nodes`,
-- `link` and `views` become PROJECTIONS of it — read models, rebuilt by
-- folding the log (`fold`, src/data/events.ts), and kept current by applying
-- each append to them in the same transaction (`planEventAppend`,
-- worker/handlers/event-log.ts). Nothing that reads the corpus changes.
--
-- ## The shape
--
-- One row per change to ONE entity: `entity` says which kind, `entity_id`
-- which one, `action` what happened (`create`, `update`, `delete`,
-- `restore`), and `patch` the fields it set, as ABSOLUTE values — never a
-- relative diff — so an event means the same thing wherever it is replayed,
-- and a run of them rolls up by keeping the last value of each field.
--
-- `seq` is the tenant's one sequence, the same one 0005 introduced: a
-- projection row's `seq` is the `seq` of the last event applied to it, so the
-- since-cursor pull keeps working unchanged.
--
-- ## What is stored so a moment can be viewed again
--
-- `received_at` is the REPLICA's clock. A point in time is asked for as a
-- time and answered as a `seq` — the last event received by then — and only
-- the replica's clock can be trusted to order that; `at`, the writer's, is
-- kept for what it says about the writer and never used to order anything.
-- `v` is the shape the patch was written in, so a reader years on can still
-- upcast it. `actor` is who wrote it (a share's grantee writes into the
-- owner's log), `origin` the door it came through (`replica`, `mcp`, `share`,
-- `system`), `device` and `client` the tab and the build, `cause` the command
-- when the writer names one, `base_seq` what the writer believed it was
-- changing, and `ref_seq` — on a restore — the moment being returned to.
--
-- ## No backfill here
--
-- There is no genesis statement in this file, deliberately. `npm run deploy`
-- applies migrations BEFORE it uploads the Worker, so rows written by the old
-- Worker in between would be missing from a log seeded here. Instead the
-- Worker reconciles inside every write's transaction (`planReconcile`): any
-- row holding a `seq` the log has no event at is recorded as a snapshot
-- `create`. A tenant's first write after the deploy seeds its whole corpus
-- that way, and a row that ever reaches the tables around the log is caught
-- by the next write rather than drifting forever.
--
-- ## Append-only, structurally
--
-- The triggers refuse UPDATE outright and refuse DELETE unless the tenant is
-- named in `event_purges` — the one door left open, for erasing an account.

CREATE TABLE events (
  user_id     INTEGER NOT NULL,
  seq         INTEGER NOT NULL,   -- per-tenant total order, assigned at append
  id          TEXT NOT NULL,      -- unique per tenant; the idempotency key
  entity      TEXT NOT NULL CHECK (entity IN ('block', 'link', 'view')),
  entity_id   TEXT NOT NULL,      -- block id | source|destination|kind | view id
  action      TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'restore')),
  patch       TEXT NOT NULL CHECK (json_valid(patch)),  -- absolute field values
  v           INTEGER NOT NULL DEFAULT 1,               -- event schema version
  batch       TEXT NOT NULL,      -- one gesture / one push = one batch
  origin      TEXT NOT NULL,      -- replica | mcp | share | system
  device      TEXT NOT NULL,      -- the tab, device or agent that wrote it
  client      TEXT,               -- the build that wrote it
  cause       TEXT,               -- the command, when the writer names one
  actor       INTEGER NOT NULL,   -- the verified user who wrote it
  base_seq    INTEGER,            -- the entity's seq as the writer last saw it
  ref_seq     INTEGER,            -- restore: the seq whose state this returns to
  at          INTEGER NOT NULL,   -- writer's clock, ms — informational, never ordering
  received_at INTEGER NOT NULL,   -- replica's clock, ms — what "as of" is asked against
  append      TEXT NOT NULL,      -- the request that appended it
  PRIMARY KEY (user_id, seq)
);

CREATE UNIQUE INDEX events_id ON events (user_id, id);
CREATE INDEX events_entity ON events (user_id, entity, entity_id, seq);
CREATE INDEX events_received ON events (user_id, received_at);

CREATE TABLE event_purges (
  user_id    INTEGER PRIMARY KEY,
  reason     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER events_no_delete BEFORE DELETE ON events
WHEN NOT EXISTS (SELECT 1 FROM event_purges WHERE user_id = OLD.user_id)
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

-- ## Views that hold no sequence
--
-- The 0015 and 0017 backfills wrote their views with `seq = 0` on purpose: an
-- owner's devices had no need to pull them. The log cannot leave them there.
-- The reconcile above finds a row by its `seq`, and a projection row's `seq`
-- names the event it came from, so a row at 0 is a row the log would never
-- hold — the fold and the tables would disagree from the first day. They are
-- numbered here, above their tenant's maximum, in the order they were
-- written; the cost is that each device pulls those few rows once. Computed
-- into a scratch table first, because an UPDATE that reads MAX(seq) from the
-- table it is writing sees its own earlier rows.

CREATE TABLE _views_reseq AS
SELECT v.user_id, v.id,
       (SELECT COALESCE(MAX(s), 0) FROM (
          SELECT MAX(seq) AS s FROM nodes WHERE user_id = v.user_id
          UNION ALL SELECT MAX(seq) FROM link WHERE user_id = v.user_id
          UNION ALL SELECT MAX(seq) FROM views WHERE user_id = v.user_id))
       + ROW_NUMBER() OVER (PARTITION BY v.user_id ORDER BY v.updated_at, v.id) AS seq
FROM views v WHERE v.seq = 0;

UPDATE views
SET seq = (SELECT r.seq FROM _views_reseq r WHERE r.user_id = views.user_id AND r.id = views.id)
WHERE seq = 0;

DROP TABLE _views_reseq;
