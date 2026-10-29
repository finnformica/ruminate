-- Migration number: 0030    2026-10-28
--
-- Genesis, once, for every tenant: a snapshot in `events_log` of every row
-- of `nodes`, `link` and `views` the log holds no event for. This is the
-- snapshot `planReconcile` wrote on every pull and every write until this
-- migration (docs/event-sourcing.md, "Genesis"): a `create` and a `set` per
-- register, a block's props keys as `delta_mat_values` holds them, under
-- one stamp — the one the row's `updated_at` and its new `seq` derive. The
-- row then takes that `seq`, the last of its snapshot, and loses its
-- `stamps`, so it resolves every register by that one stamp.
--
-- The reconcile is gone from the Worker with this migration: it read the
-- whole tenant log four times on every pull and every push (bench of
-- 2026-10-28: 186,526 rows for a sync pull that found nothing, 378,961 for
-- a push of one edit, at 46,620 events). A row is unlogged only once, at
-- genesis, so genesis runs once, here. A statement run in the console that
-- writes a row around the log is not repaired any more: `verify` reports it.
--
-- "Unlogged" is "no event for this entity", not "a `seq` above the log's
-- MAX". The two differ: a tenant whose rows were snapshotted into the OLD
-- log (`events`) by the reconcile of 0023 holds those rows at that log's
-- sparse `seq` (one tenant in production: 322 blocks, 371 links and 10
-- views at `seq` 6,424 to 13,618 above a per-key log of 6,393 rows that
-- mirrors every one of them). The second statement gives such a row the
-- `seq` of its last key event, so no row sits above its log. Every other
-- row's `seq` already names the event it came from.
--
-- Every compound SELECT here has at most three terms (D1 allows five).

INSERT INTO events_log (user_id, seq, id, entity, entity_id, action, key, value, v, batch,
  origin, device, client, cause, actor, base_seq, ref_seq, at, tz, hlc, received_at, append,
  event_id, event_seq)
WITH stray AS (
  SELECT n.user_id, 'block' AS entity, n.id AS entity_id, n.seq, n.updated_at AS at,
    n.deleted_at, json_object('type', n.type, 'text', n.text, 'notes_id', n.notes_id) AS fields
  FROM nodes n
  WHERE NOT EXISTS (SELECT 1 FROM events_log l
    WHERE l.user_id = n.user_id AND l.entity = 'block' AND l.entity_id = n.id)
  UNION ALL
  SELECT k.user_id, 'link', k.source_id || '|' || k.destination_id || '|' || k.kind, k.seq,
    k.updated_at, k.deleted_at, json_object('source_id', k.source_id,
    'destination_id', k.destination_id, 'kind', k.kind, 'sort_key', k.sort_key)
  FROM link k
  WHERE NOT EXISTS (SELECT 1 FROM events_log l
    WHERE l.user_id = k.user_id AND l.entity = 'link'
      AND l.entity_id = k.source_id || '|' || k.destination_id || '|' || k.kind)
  UNION ALL
  SELECT v.user_id, 'view', v.id, v.seq, v.updated_at, v.deleted_at,
    json_object('root_id', v.root_id, 'filter', v.filter, 'sort', v.sort,
    'pinned', json(CASE v.pinned WHEN 1 THEN 'true' ELSE 'false' END),
    'sort_key', v.sort_key, 'stack', v.stack)
  FROM views v
  WHERE NOT EXISTS (SELECT 1 FROM events_log l
    WHERE l.user_id = v.user_id AND l.entity = 'view' AND l.entity_id = v.id)
),
-- The column registers of each entity, in the order a snapshot numbers them
-- (`COLUMN_REGISTERS`, src/data/key-events.ts; 0028 spelled the same list).
columns AS (
  SELECT json_extract(c.value, '$.entity') AS entity, json_extract(c.value, '$.name') AS name,
    json_extract(c.value, '$.ordinal') AS ordinal
  FROM json_each('[{"entity":"block","name":"type","ordinal":1},{"entity":"block","name":"text","ordinal":2},{"entity":"block","name":"notes_id","ordinal":3},
    {"entity":"link","name":"source_id","ordinal":1},{"entity":"link","name":"destination_id","ordinal":2},{"entity":"link","name":"kind","ordinal":3},
    {"entity":"link","name":"sort_key","ordinal":4},{"entity":"view","name":"root_id","ordinal":1},{"entity":"view","name":"filter","ordinal":2},
    {"entity":"view","name":"sort","ordinal":3},{"entity":"view","name":"pinned","ordinal":4},{"entity":"view","name":"sort_key","ordinal":5},
    {"entity":"view","name":"stack","ordinal":6}]') AS c
),
rows AS (
  SELECT s.*, 0 AS ordinal, 'create' AS action, '' AS k,
    CASE WHEN s.deleted_at IS NULL THEN 'null' ELSE CAST(s.deleted_at AS TEXT) END AS val
  FROM stray s
  UNION ALL
  SELECT s.*, c.ordinal, 'set', c.name, s.fields -> ('$.' || c.name)
  FROM stray s JOIN columns c ON c.entity = s.entity
  WHERE json_type(s.fields, '$.' || c.name) IS NOT NULL
  UNION ALL
  SELECT s.*, 10, 'set', 'props.' || b.key, b.value
  FROM stray s JOIN delta_mat_values b
    ON b.user_id = s.user_id AND b.block_id = s.entity_id AND b.value IS NOT NULL
  WHERE s.entity = 'block'
),
numbered AS (
  SELECT r.*,
    ROW_NUMBER() OVER (PARTITION BY r.user_id
      ORDER BY r.seq, r.entity, r.entity_id, r.ordinal, r.k) AS rn,
    ROW_NUMBER() OVER (PARTITION BY r.user_id, r.entity, r.entity_id
      ORDER BY r.ordinal, r.k) - 1 AS n,
    (SELECT COALESCE(MAX(l.seq), 0) FROM events_log l WHERE l.user_id = r.user_id) AS base
  FROM rows r
)
SELECT m.user_id, m.base + m.rn,
  'snap_' || m.entity || '_' || m.entity_id || '_' || m.seq || '#' || m.n,
  m.entity, m.entity_id, m.action, m.k, m.val, 2, 'snapshot', 'system', 'replica', NULL,
  'snapshot', m.user_id, NULL, NULL, m.at, NULL,
  printf('%015d-0000-seq:%015d', MIN(MAX(m.at, 0), 999999999999999),
    m.base + MAX(m.rn) OVER (PARTITION BY m.user_id, m.entity, m.entity_id)),
  CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'genesis_0030',
  'snap_' || m.entity || '_' || m.entity_id || '_' || m.seq, NULL
FROM numbered m WHERE true
ON CONFLICT DO NOTHING;

-- A row the old log snapshotted at its sparse `seq` takes the `seq` of its
-- last key event. Only rows above their tenant's log, and only rows the log
-- holds an event for: a row the first statement just snapshotted is handled
-- by the three statements after this one.
UPDATE nodes SET seq = (SELECT MAX(l.seq) FROM events_log l
    WHERE l.user_id = nodes.user_id AND l.entity = 'block' AND l.entity_id = nodes.id)
WHERE seq > (SELECT COALESCE(MAX(l.seq), 0) FROM events_log l WHERE l.user_id = nodes.user_id)
  AND EXISTS (SELECT 1 FROM events_log l
    WHERE l.user_id = nodes.user_id AND l.entity = 'block' AND l.entity_id = nodes.id
      AND l.append <> 'genesis_0030');

UPDATE link SET seq = (SELECT MAX(l.seq) FROM events_log l
    WHERE l.user_id = link.user_id AND l.entity = 'link'
      AND l.entity_id = link.source_id || '|' || link.destination_id || '|' || link.kind)
WHERE seq > (SELECT COALESCE(MAX(l.seq), 0) FROM events_log l WHERE l.user_id = link.user_id)
  AND EXISTS (SELECT 1 FROM events_log l
    WHERE l.user_id = link.user_id AND l.entity = 'link'
      AND l.entity_id = link.source_id || '|' || link.destination_id || '|' || link.kind
      AND l.append <> 'genesis_0030');

UPDATE views SET seq = (SELECT MAX(l.seq) FROM events_log l
    WHERE l.user_id = views.user_id AND l.entity = 'view' AND l.entity_id = views.id)
WHERE seq > (SELECT COALESCE(MAX(l.seq), 0) FROM events_log l WHERE l.user_id = views.user_id)
  AND EXISTS (SELECT 1 FROM events_log l
    WHERE l.user_id = views.user_id AND l.entity = 'view' AND l.entity_id = views.id
      AND l.append <> 'genesis_0030');

-- A snapshotted row takes the `seq` of the last row of its snapshot and
-- loses its `stamps`: it resolves every register by the stamp the snapshot
-- derives, as a row from before 0025 does.
UPDATE nodes SET stamps = NULL, seq = (SELECT MAX(l.seq) FROM events_log l
    WHERE l.user_id = nodes.user_id AND l.entity = 'block' AND l.entity_id = nodes.id
      AND l.append = 'genesis_0030')
WHERE EXISTS (SELECT 1 FROM events_log l
    WHERE l.user_id = nodes.user_id AND l.entity = 'block' AND l.entity_id = nodes.id
      AND l.append = 'genesis_0030');

UPDATE link SET stamps = NULL, seq = (SELECT MAX(l.seq) FROM events_log l
    WHERE l.user_id = link.user_id AND l.entity = 'link'
      AND l.entity_id = link.source_id || '|' || link.destination_id || '|' || link.kind
      AND l.append = 'genesis_0030')
WHERE EXISTS (SELECT 1 FROM events_log l
    WHERE l.user_id = link.user_id AND l.entity = 'link'
      AND l.entity_id = link.source_id || '|' || link.destination_id || '|' || link.kind
      AND l.append = 'genesis_0030');

UPDATE views SET stamps = NULL, seq = (SELECT MAX(l.seq) FROM events_log l
    WHERE l.user_id = views.user_id AND l.entity = 'view' AND l.entity_id = views.id
      AND l.append = 'genesis_0030')
WHERE EXISTS (SELECT 1 FROM events_log l
    WHERE l.user_id = views.user_id AND l.entity = 'view' AND l.entity_id = views.id
      AND l.append = 'genesis_0030');

-- The keys a snapshot read, at its stamp and seq: the same rows of
-- `delta_mat_values`, now stamped as the snapshot says, as its other
-- registers are.
UPDATE delta_mat_values SET
  hlc = (SELECT l.hlc FROM events_log l
    WHERE l.user_id = delta_mat_values.user_id AND l.entity = 'block'
      AND l.entity_id = delta_mat_values.block_id AND l.append = 'genesis_0030'
      AND l.key = 'props.' || delta_mat_values.key),
  seq = (SELECT MAX(l.seq) FROM events_log l
    WHERE l.user_id = delta_mat_values.user_id AND l.entity = 'block'
      AND l.entity_id = delta_mat_values.block_id AND l.append = 'genesis_0030'),
  updated_at = (SELECT l.at FROM events_log l
    WHERE l.user_id = delta_mat_values.user_id AND l.entity = 'block'
      AND l.entity_id = delta_mat_values.block_id AND l.append = 'genesis_0030'
      AND l.key = 'props.' || delta_mat_values.key)
WHERE EXISTS (SELECT 1 FROM events_log l
    WHERE l.user_id = delta_mat_values.user_id AND l.entity = 'block'
      AND l.entity_id = delta_mat_values.block_id AND l.append = 'genesis_0030'
      AND l.key = 'props.' || delta_mat_values.key);
