-- SPIKE (docs/event-sourcing.md), 2026-09-21. Kept OUT of `migrations/` on purpose — see
-- events.sql. Takes the number after it at cutover.
--
-- Genesis: seed the log from the rows, so the log can BE the truth.
--
-- A log that starts today knows nothing of yesterday's corpus, and a fold of
-- it would produce an empty one. So every existing row becomes one `create`
-- event carrying the row as it stands — a snapshot taken as events. It is the
-- only place a `create` may carry `deleted_at`: a tombstoned row has no
-- history to replay, only a final state to record.
--
-- Each genesis event takes the `seq` its row already holds. 0005 made `seq`
-- unique per tenant across the corpus tables, so the log's primary key holds
-- without renumbering, every device's pull cursor stays valid, and the first
-- real event lands at MAX(seq) + 1 exactly as the next row write would have.
--
-- Separate from events.sql for the reason 0016 is separate from 0015: the table is
-- additive and safe on its own; this step belongs with the Worker that
-- appends, or rows written between the two would be missing from the log.

-- ## First: rows that never got a sequence
--
-- The argument above needs every row to HOLD a sequence, and 0015's backfill
-- wrote its views with the column default, `seq = 0` — four of production's
-- seven views on 2026-09-21, two of them one tenant's. That is a bug of its
-- own (`seq > cursor` can never deliver such a row, so those views reach a
-- second device only by a full pull) and it would break the log's primary
-- key. So they are numbered first, above their tenant's maximum, in the order
-- they were written. Computed into a scratch table rather than in the UPDATE
-- itself: an UPDATE that reads MAX(seq) from the table it is writing sees its
-- own earlier rows, and the numbers it hands out depend on the order it
-- happens to visit them in.

CREATE TABLE _genesis_reseq AS
SELECT v.user_id, v.id,
       (SELECT COALESCE(MAX(s), 0) FROM (
          SELECT MAX(seq) AS s FROM nodes WHERE user_id = v.user_id
          UNION ALL SELECT MAX(seq) FROM link WHERE user_id = v.user_id
          UNION ALL SELECT MAX(seq) FROM views WHERE user_id = v.user_id))
       + ROW_NUMBER() OVER (PARTITION BY v.user_id ORDER BY v.updated_at, v.id) AS seq
FROM views v WHERE v.seq = 0;

UPDATE views
SET seq = (SELECT r.seq FROM _genesis_reseq r WHERE r.user_id = views.user_id AND r.id = views.id)
WHERE seq = 0;

DROP TABLE _genesis_reseq;

INSERT INTO events (user_id, seq, id, entity, entity_id, action, patch, v, batch, device, cause, actor, at, received_at, append)
SELECT user_id, seq, 'gen_block_' || id, 'block', id, 'create',
       json_object('type', type, 'text', text, 'props', props, 'notes_id', notes_id, 'deleted_at', deleted_at),
       1, 'genesis', 'replica', 'genesis', user_id, updated_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'genesis'
FROM nodes;

INSERT INTO events (user_id, seq, id, entity, entity_id, action, patch, v, batch, device, cause, actor, at, received_at, append)
SELECT user_id, seq, 'gen_link_' || source_id || '|' || destination_id || '|' || kind, 'link',
       source_id || '|' || destination_id || '|' || kind, 'create',
       json_object('source_id', source_id, 'destination_id', destination_id, 'kind', kind,
                   'sort_key', sort_key, 'deleted_at', deleted_at),
       1, 'genesis', 'replica', 'genesis', user_id, updated_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'genesis'
FROM link;

INSERT INTO events (user_id, seq, id, entity, entity_id, action, patch, v, batch, device, cause, actor, at, received_at, append)
SELECT user_id, seq, 'gen_view_' || id, 'view', id, 'create',
       json_object('root_id', root_id, 'filter', filter, 'sort', sort, 'pinned', json(CASE pinned WHEN 1 THEN 'true' ELSE 'false' END),
                   'sort_key', sort_key, 'deleted_at', deleted_at),
       1, 'genesis', 'replica', 'genesis', user_id, updated_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'genesis'
FROM views;
