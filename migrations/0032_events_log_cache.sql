-- Migration number: 0032    2026-10-30
--
-- The cache of the log (docs/events-log-cache.md): `events_log_cache`, one
-- row per KEY of one entity — a block's `type`, `text`, `notes_id`, its
-- liveness as `deleted` and one `props.<name>` per entry of its props; a
-- link's `source_id`, `destination_id`, `kind`, `sort_key` and `deleted` —
-- holding the register's current value as JSON, the stamp of the event that
-- set it, that event's seq and the writer's clock. It is `delta_mat_values`
-- (0028) widened to every register of a block and a link, with the same
-- shape on every device (the local ladder's v18 step). From this migration
-- on the Worker reads every block and link from it, and writes it in the
-- same batch as every append (`worker/handlers/event-log.ts`). `nodes`,
-- `link` and `delta_mat_values` stay in place, UNWRITTEN, until a later
-- migration drops them: they are the rollback of this deploy (the doc,
-- "Migration order and rollback").
--
-- ## The backfill
--
-- The fold by stamp of `events_log`, key by key: for every register of
-- every block and link, the row with the highest stamp — the event's own
-- (`hlc`), or the one it derives (`keyEventStamp`, src/data/key-events.ts:
-- `at`, counter 0, `seq:` with the OLD log's seq for a row mirrored from
-- it, else its own). So the cache equals the fold on day one, which is
-- what `GET /api/replica/verify` checks from here on. On production of
-- 2026-10-28 that fold agreed with the tables on every register
-- (28,236 of them for the largest tenant; docs/events-log-cache.md,
-- "Bench plan"). The liveness rows read as `registerOf` reads them: a
-- `create` gives its value (`null`, or the tombstone it arrived dead
-- with), a `delete` its value or the event's clock, a `restore` `null`.
-- View events are history only (docs/removing-views.md): no row.
--
-- ## The watermark
--
-- `meta.cache_seq` is the seq of the last log row the cache has projected.
-- The Worker's append reads it, projects every row above it that the
-- append does not hold (normally none), and writes it in the same batch.
-- It closes the deploy window: `npm run deploy` applies this migration
-- before it uploads the Worker, and the Worker before this one appends to
-- the log and never to the cache.
--
-- No compound SELECT here (D1 allows five terms); the backfill is one
-- statement over a window.

CREATE TABLE events_log_cache (
  user_id    INTEGER NOT NULL,
  entity     TEXT NOT NULL CHECK (entity IN ('block', 'link')),
  entity_id  TEXT NOT NULL,
  key        TEXT NOT NULL CHECK (
               key GLOB '[A-Za-z_]*'
               AND key NOT GLOB '*[^A-Za-z0-9_.:-]*'
               AND length(key) <= 134),
  value      TEXT CHECK (value IS NULL OR json_valid(value)),  -- JSON; NULL = an unset props key
  hlc        TEXT NOT NULL,       -- the stamp of the event that set it
  seq        INTEGER NOT NULL,    -- that event's seq in events_log
  updated_at INTEGER NOT NULL,    -- that event's `at`, the writer's clock
  PRIMARY KEY (user_id, entity, entity_id, key)
);

-- The lookups, one partial index each (a partial index on `key IN (…)` is
-- not used for a `key = …` seek): children by source, parents by
-- destination, a note's blocks by `notes_id`, the notes by type.
CREATE INDEX events_log_cache_source ON events_log_cache (user_id, value) WHERE key = 'source_id';
CREATE INDEX events_log_cache_destination ON events_log_cache (user_id, value)
  WHERE key = 'destination_id';
CREATE INDEX events_log_cache_notes ON events_log_cache (user_id, value) WHERE key = 'notes_id';
CREATE INDEX events_log_cache_type ON events_log_cache (user_id, value) WHERE key = 'type';
-- What changed since a seq: the row endpoints served to a build before this
-- one, and the watermark catch-up. Replaces delta_mat_values_seq.
CREATE INDEX events_log_cache_seq ON events_log_cache (user_id, seq);

INSERT INTO events_log_cache (user_id, entity, entity_id, key, value, hlc, seq, updated_at)
SELECT w.user_id, w.entity, w.entity_id, w.k, w.val, w.stamp, w.seq, w.at
FROM (
  SELECT r.*,
    ROW_NUMBER() OVER (
      PARTITION BY r.user_id, r.entity, r.entity_id, r.k
      ORDER BY r.stamp DESC, r.seq ASC) AS rn
  FROM (
    SELECT l.user_id, l.entity, l.entity_id, l.seq, l.at,
      CASE WHEN l.action IN ('set', 'unset') THEN l.key ELSE 'deleted' END AS k,
      CASE l.action
        WHEN 'set' THEN l.value
        WHEN 'unset' THEN NULL
        WHEN 'restore' THEN 'null'
        WHEN 'delete' THEN CASE WHEN l.value = 'null' THEN CAST(l.at AS TEXT) ELSE l.value END
        ELSE l.value
      END AS val,
      COALESCE(l.hlc, printf('%015d-0000-seq:%015d',
        MIN(MAX(l.at, 0), 999999999999999), COALESCE(l.event_seq, l.seq))) AS stamp
    FROM events_log l
    WHERE l.entity IN ('block', 'link')
  ) AS r
) AS w
WHERE w.rn = 1
ON CONFLICT DO NOTHING;

INSERT INTO meta (user_id, key, value)
SELECT user_id, 'cache_seq', CAST(MAX(seq) AS TEXT) FROM events_log GROUP BY user_id
ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value;
