-- Migration number: 0028    2026-10-27
--
-- The per-key event log, beside the old one (docs/event-sourcing.md,
-- "Per-key events"). One row of `events_log` is one change to ONE KEY of one
-- entity: a block's `type`, `text`, `notes_id` or one `props.<name>`; a
-- link's or a view's columns. A whole-`props` patch of the old log reads as
-- one `set` per key whose value differs and one `unset` per key that is
-- gone, so two devices that change two keys of one block both keep their
-- change. The old `events` table stays, and is still written beside this
-- one: a revert is a flip of `EVENT_LOG_ROLLUP` (worker/handlers/event-log.ts).
--
-- ## The shape
--
-- `action` is `create`, `set`, `unset`, `delete` or `restore`. A `create`,
-- `delete` or `restore` row is about the entity's liveness: its `key` is ""
-- and its `value` the tombstone's stamp (`deleted_at`) or null. A `set` row
-- names a register in `key` and carries its value as JSON in `value`; an
-- `unset` names a `props.<name>` register and carries null. The CHECKs hold
-- every row to that: a JSON value, an action of the five, an entity of the
-- three, and a key of letters, digits, `_`, `.`, `:` and `-` that starts
-- with a letter or `_` (`KEY_PATTERN`, src/data/key-events.ts).
--
-- `seq` is this log's own total order. `event_id` and `event_seq` name the
-- `events` row each row mirrors while both logs are written: the row
-- cursors still count in the old log's `seq`.
--
-- Everything else is what `events` stores beside a change (0023, 0024).
--
-- ## The backfill
--
-- Every event the old log holds is expanded here, in `seq` order, each
-- read against the props the block's previous event that named props left
-- (`LAG`, as a correlated read). The Worker runs the same expansion on
-- every write for the events the old Worker appends between this migration
-- and the upload (`planLogFill`), and `src/data/key-events.ts` spells it in
-- TypeScript (`expandEvent`); a test pins the three together. A props key
-- that does not match the pattern is left out rather than fail the
-- migration; `GET /api/replica/verify` reports the block it was on.
--
-- ## delta_mat_values
--
-- The per-key read model of a block's props: one row per (block, key) with
-- the key's current value as JSON, or NULL for a key that was unset (the
-- tombstone keeps its stamp, so an older set that arrives later loses to
-- it). `hlc` is the stamp of the event that set it; `seq` and `updated_at`
-- the old log's seq and the writer's clock of that event. `nodes.props` is
-- derived from these rows under the new rollup. No backfill here: the
-- Worker seeds a tenant's rows once, from the per-key fold, on its first
-- write or verify (`seedDeltaMatValues`), so the rows are exactly the fold's.

CREATE TABLE events_log (
  user_id     INTEGER NOT NULL,
  seq         INTEGER NOT NULL,   -- this log's own per-tenant total order
  id          TEXT NOT NULL,      -- unique per tenant; the idempotency key
  entity      TEXT NOT NULL CHECK (entity IN ('block', 'link', 'view')),
  entity_id   TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('create', 'set', 'unset', 'delete', 'restore')),
  key         TEXT NOT NULL CHECK (
                CASE WHEN action IN ('set', 'unset')
                  THEN key GLOB '[A-Za-z_]*'
                    AND key NOT GLOB '*[^A-Za-z0-9_.:-]*'
                    AND length(key) <= 134
                  ELSE key = ''
                END),
  value       TEXT NOT NULL CHECK (json_valid(value)),  -- JSON; 'null' for none
  v           INTEGER NOT NULL DEFAULT 2,               -- event schema version
  batch       TEXT NOT NULL,
  origin      TEXT NOT NULL,      -- replica | mcp | share | system
  device      TEXT NOT NULL,
  client      TEXT,
  cause       TEXT,
  actor       INTEGER NOT NULL,
  base_seq    INTEGER,
  ref_seq     INTEGER,
  at          INTEGER NOT NULL,   -- writer's clock, ms
  tz          INTEGER,            -- writer's UTC offset at `at`, minutes east
  hlc         TEXT,               -- the writer's stamp; NULL = derived at read
  received_at INTEGER NOT NULL,   -- replica's clock, ms
  append      TEXT NOT NULL,      -- the request that appended it
  event_id    TEXT,               -- the `events` row this mirrors
  event_seq   INTEGER,            -- that row's seq: the old log's order
  PRIMARY KEY (user_id, seq)
);

CREATE UNIQUE INDEX events_log_id ON events_log (user_id, id);
CREATE INDEX events_log_entity ON events_log (user_id, entity, entity_id, seq);
CREATE INDEX events_log_event ON events_log (user_id, event_id);
CREATE INDEX events_log_received ON events_log (user_id, received_at);

CREATE TRIGGER events_log_no_update BEFORE UPDATE ON events_log
BEGIN
  SELECT RAISE(ABORT, 'events_log is append-only');
END;

CREATE TRIGGER events_log_no_delete BEFORE DELETE ON events_log
WHEN NOT EXISTS (SELECT 1 FROM event_purges WHERE user_id = OLD.user_id)
BEGIN
  SELECT RAISE(ABORT, 'events_log is append-only');
END;

CREATE TABLE delta_mat_values (
  user_id    INTEGER NOT NULL,
  block_id   TEXT NOT NULL,
  key        TEXT NOT NULL CHECK (
               key GLOB '[A-Za-z_]*'
               AND key NOT GLOB '*[^A-Za-z0-9_.:-]*'
               AND length(key) <= 128),
  value      TEXT CHECK (value IS NULL OR json_valid(value)),  -- NULL = unset
  hlc        TEXT NOT NULL,       -- the stamp of the event that set it
  seq        INTEGER NOT NULL,    -- that event's seq in `events`
  updated_at INTEGER NOT NULL,    -- that event's `at`
  PRIMARY KEY (user_id, block_id, key)
);

CREATE INDEX delta_mat_values_seq ON delta_mat_values (user_id, seq);

-- The backfill: every `events` row that `events_log` does not mirror yet,
-- read per key. The same statement, scoped to one tenant, is `planLogFill`.
INSERT INTO events_log (user_id, seq, id, entity, entity_id, action, key, value, v, batch,
  origin, device, client, cause, actor, base_seq, ref_seq, at, tz, hlc, received_at, append,
  event_id, event_seq)
WITH pending AS (
  SELECT e.*,
    CASE WHEN e.entity = 'block' AND json_type(e.patch, '$.props') = 'text'
      AND json_valid(json_extract(e.patch, '$.props'))
      THEN json_extract(e.patch, '$.props') END AS props_new,
    CASE WHEN e.entity = 'block' AND json_type(e.patch, '$.props') IS NOT NULL
      THEN 1 ELSE 0 END AS names_props,
    CASE WHEN e.entity = 'block' AND json_type(e.patch, '$.props') IS NOT NULL THEN
      (SELECT CASE WHEN json_type(p.patch, '$.props') = 'text'
          AND json_valid(json_extract(p.patch, '$.props'))
          THEN json_extract(p.patch, '$.props') END
        FROM events p
        WHERE p.user_id = e.user_id AND p.entity = 'block' AND p.entity_id = e.entity_id
          AND p.seq < e.seq AND json_type(p.patch, '$.props') IS NOT NULL
        ORDER BY p.seq DESC LIMIT 1)
    END AS props_prior
  FROM events e
  WHERE NOT EXISTS (SELECT 1 FROM events_log l WHERE l.user_id = e.user_id AND l.event_id = e.id)
),
-- The columns each entity has, as one JSON literal: D1 allows at most five
-- terms in a compound SELECT, so a UNION ALL per column is not an option.
columns AS (
  SELECT json_extract(c.value, '$.entity') AS entity, json_extract(c.value, '$.name') AS name,
    json_extract(c.value, '$.ordinal') AS ordinal
  FROM json_each('[{"entity":"block","name":"type","ordinal":1},{"entity":"block","name":"text","ordinal":2},{"entity":"block","name":"notes_id","ordinal":3},
    {"entity":"link","name":"source_id","ordinal":1},{"entity":"link","name":"destination_id","ordinal":2},{"entity":"link","name":"kind","ordinal":3},
    {"entity":"link","name":"sort_key","ordinal":4},{"entity":"view","name":"root_id","ordinal":1},{"entity":"view","name":"filter","ordinal":2},
    {"entity":"view","name":"sort","ordinal":3},{"entity":"view","name":"pinned","ordinal":4},{"entity":"view","name":"sort_key","ordinal":5},
    {"entity":"view","name":"stack","ordinal":6}]') AS c
),
expanded AS (
  SELECT p.*, 0 AS ordinal, p.action AS k_action, '' AS k,
    CASE WHEN json_type(p.patch, '$.deleted_at') = 'integer'
      THEN json_extract(p.patch, '$.deleted_at') ELSE 'null' END AS val
  FROM pending p WHERE p.action <> 'update'
  UNION ALL
  SELECT p.*, c.ordinal, 'set', c.name, p.patch -> ('$.' || c.name)
  FROM pending p JOIN columns c ON c.entity = p.entity
  WHERE json_type(p.patch, '$.' || c.name) IS NOT NULL
  UNION ALL
  SELECT p.*, 10, 'set', 'props.' || n.key, p.props_new -> n.fullkey
  FROM pending p, json_each(p.props_new) AS n
  WHERE p.names_props AND n.type <> 'null'
    AND n.key GLOB '[A-Za-z_]*' AND n.key NOT GLOB '*[^A-Za-z0-9_.:-]*' AND length(n.key) <= 128
    AND (p.props_prior IS NULL
      OR (p.props_prior -> n.fullkey) IS NULL
      OR (p.props_prior -> n.fullkey) = 'null'
      OR (p.props_prior -> n.fullkey) <> (p.props_new -> n.fullkey))
  UNION ALL
  SELECT p.*, 11, 'unset', 'props.' || o.key, 'null'
  FROM pending p, json_each(p.props_prior) AS o
  WHERE p.names_props AND o.type <> 'null'
    AND o.key GLOB '[A-Za-z_]*' AND o.key NOT GLOB '*[^A-Za-z0-9_.:-]*' AND length(o.key) <= 128
    AND (p.props_new IS NULL
      OR (p.props_new -> o.fullkey) IS NULL
      OR (p.props_new -> o.fullkey) = 'null')
)
SELECT r.user_id,
  (SELECT COALESCE(MAX(l.seq), 0) FROM events_log l WHERE l.user_id = r.user_id)
    + ROW_NUMBER() OVER (PARTITION BY r.user_id ORDER BY r.seq, r.ordinal, r.k),
  r.id || '#' || (ROW_NUMBER() OVER (PARTITION BY r.user_id, r.id ORDER BY r.ordinal, r.k) - 1),
  r.entity, r.entity_id, r.k_action, r.k, r.val, 2, r.batch, r.origin, r.device, r.client,
  r.cause, r.actor, r.base_seq, r.ref_seq, r.at, r.tz, r.hlc, r.received_at, r.append,
  r.id, r.seq
FROM expanded r WHERE true
ON CONFLICT DO NOTHING;
