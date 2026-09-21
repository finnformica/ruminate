-- SPIKE (docs/event-sourcing.md), 2026-09-21. Kept OUT of `migrations/` on purpose: a merge to
-- main runs `migrate:remote`, and this table means nothing until the Worker appends to it. It
-- takes the next free migration number at cutover.
--
-- The event log: every change to a block, a link or a view, as an appended
-- row, in one total order per tenant.
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
-- existing since-cursor pull keeps working unchanged, and `events_genesis.sql` seeds the log
-- from the rows under the seqs they already hold.
--
-- `id` is minted by the writer and unique per tenant: it is the idempotency
-- key. A push retried after a lost response (the keepalive flush on
-- `pagehide` does this) inserts nothing the second time.
--
-- `batch` groups the events one gesture produced; `device`, `cause` and
-- `base_seq` exist for the question the incident could not answer: which tab,
-- running which command, believing what about the row, wrote this?
--
-- ## Append-only, structurally
--
-- The triggers below refuse UPDATE outright and refuse DELETE unless the
-- tenant is named in `event_purges` — the one door left open, for erasing an
-- account (a legal obligation an immutable log must still be able to meet).

CREATE TABLE events (
  user_id     INTEGER NOT NULL,
  seq         INTEGER NOT NULL,   -- per-tenant total order, assigned at append
  id          TEXT NOT NULL,      -- writer-minted; the idempotency key
  entity      TEXT NOT NULL CHECK (entity IN ('block', 'link', 'view')),
  entity_id   TEXT NOT NULL,      -- block id | source|destination|kind | view id
  action      TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'restore')),
  patch       TEXT NOT NULL CHECK (json_valid(patch)),  -- absolute field values
  v           INTEGER NOT NULL DEFAULT 1,               -- event schema version
  batch       TEXT NOT NULL,      -- one gesture = one batch
  device      TEXT NOT NULL,      -- tab/device/agent that wrote it
  cause       TEXT,               -- the command: 'backspaceEmpty', 'undo', 'mcp:…'
  actor       INTEGER NOT NULL,   -- the verified user who wrote it (shares: not always the owner)
  base_seq    INTEGER,            -- the entity's seq as the writer last saw it
  ref_seq     INTEGER,            -- restore: the seq whose state this returns to
  at          INTEGER NOT NULL,   -- writer's clock, ms — informational, never ordering
  received_at INTEGER NOT NULL,   -- replica's clock, ms
  append      TEXT NOT NULL,      -- the request that appended it
  PRIMARY KEY (user_id, seq)
);

CREATE UNIQUE INDEX events_id ON events (user_id, id);
CREATE INDEX events_entity ON events (user_id, entity, entity_id, seq);

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
