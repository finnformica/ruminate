# Events log cache

Status: **proposed 2026-10-28, step 2 of the D1 plan. Finn approves this
document before any code.** It assumes two branches have merged: step 1
(migration 0030: genesis for every tenant, no reconcile in the Worker) and
remove-views (no `views` table, no view events written, a share names its
root). It covers blocks and links only.

Today the server holds the log (`events_log`) and three kinds of projection
beside it: `nodes` and `link` (one row per entity, with a `stamps` JSON
column), `delta_mat_values` (one row per props key) and the `nodes.props`
mirror. Every device holds the same four, and pulls rows and the log both.
This document replaces all of that with **two tables of the same shape on
the server and on every device**:

| table              | what                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `events_log`       | The history. The truth. Append-only, one row per key of one entity (docs/event-sourcing.md).            |
| `events_log_cache` | The current value of every key of every entity, one row per `(entity, entity_id, key)`, with its stamp. |

The cache is `delta_mat_values` widened to every register: a block's `type`,
`text`, `notes_id`, `deleted` and `props.*`; a link's `source_id`,
`destination_id`, `kind`, `sort_key` and `deleted`. Sync is the log and
nothing else. Every server reader reads the cache. `nodes`, `link` and the
mirror are dropped.

Measured on the production copy of 2026-10-28 (Finn's tenant: 2,712 blocks,
3,429 links, 242 props keys, 46,620 log rows): the cache is **28,081 rows**
and 2.3 MB of text.

## 1. The cache table

### Shape

```sql
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
```

The browser's copy has no `user_id`, and its `seq` is NULL until the event
is placed by a push (as `delta_mat_values.seq` is today). Everything else is
the same.

### Keys

One row per register. The key is the register's name in `events_log`, with
one addition: liveness is a register too, named `deleted`.

| entity | key              | value                                   | set by                                             |
| ------ | ---------------- | --------------------------------------- | -------------------------------------------------- |
| block  | `type`           | JSON string                             | `set type`                                         |
| block  | `text`           | JSON string                             | `set text`                                         |
| block  | `notes_id`       | JSON string, or no row                  | `set notes_id`                                     |
| block  | `props.<name>`   | JSON, or NULL for a key that was unset  | `set props.<name>`, `unset props.<name>`           |
| block  | `deleted`        | `null` when live, else the tombstone ms | `create`, `delete`, `restore`                      |
| link   | `source_id`      | JSON string                             | `set source_id` (the create's, never changed)      |
| link   | `destination_id` | JSON string                             | `set destination_id` (the create's, never changed) |
| link   | `kind`           | JSON string                             | `set kind` (the create's, never changed)           |
| link   | `sort_key`       | JSON string                             | `set sort_key`                                     |
| link   | `deleted`        | `null` when live, else the tombstone ms | `create`, `delete`, `restore`                      |

The `deleted` row takes its value from the liveness event: a `create` gives
its value (`null`, or `deleted_at` when it arrives dead); a `delete` gives
its value, or the event's `at` when the value is `null`; a `restore` gives
`null`. Its `hlc` is the stamp today's `stamps.alive` holds.

**Rules the rows keep.**

- A row is written only under a higher stamp (`WHERE excluded.hlc > hlc`).
  The cache is the fold by stamp of the log, key by key (`foldKeysByStamp`,
  `src/data/key-events.ts`). Two devices that change two keys of one block
  both keep their change.
- An unset props key keeps its row with `value` NULL. The tombstone keeps
  the key's stamp, so an older set that arrives later loses to it.
- An entity with no `deleted` row is **held before created**: an update
  reached it before its create. No reader of live entities sees it. The
  create, when it comes, writes the `deleted` row and the entity is live.
- Rows are never deleted. A tenant purge is the one exception
  (`event_purges`), and it deletes the log too.
- An entity's `updated_at` is the `updated_at` of its row with the highest
  `hlc`. The rollup reads it as `MAX(updated_at)` over the entity's rows,
  which is the same value except when a clock ran backwards between two
  stamps of one entity. Today's rows hold the `at` of the highest-stamp
  event; the difference is accepted.
- An entity's `seq` is `MAX(seq)` over its rows: the last event that changed
  it. It is information only. The cursor is the log's `seq`.

### A link's row shape (item 7 of the brief)

A link's id is `source|destination|kind`, as the log names it
(`linkEntityId`). Those three keys never change: the create sets them and
nothing else does. The cache holds them as rows all the same, for one
reason: **lookups**. "The children of X" is `key = 'source_id' AND value =
'"X"'` on the by-value index (section 2), and "who holds X" is the same on
`destination_id`. Three alternatives were weighed and refused:

- **Derive them from `entity_id` with a GLOB prefix** (`entity_id GLOB
'X|*'`). D1 caps a LIKE or GLOB pattern at 50 bytes. Link ids on
  production reach 46 bytes today, and an id is not bounded.
- **Derive them with a range** (`entity_id >= 'X|' AND entity_id < 'X}'`).
  This works on the primary key and needs no row, but it ties every reader
  to the id format and to the fact that no id holds a `|` (true today:
  0 of 3,644 ids). It stays as a later optimisation if the three rows per
  link ever cost too much.
- **Two columns** (`source_id`, `destination_id`) on the cache table, NULL
  for a block. This breaks "one shape, one row per key" and makes every
  reader special-case links.

Cost: 5 rows per link, 3 of them write-once. On production that is 10,287
rows of the 28,081. The boot rollup reads them in SQL (section 8), where
they cost 43 ms against a read without them of about the same (measured
below, variants B and C).

## 2. Indexes

```sql
-- An entity's rows; a block by id; a link by id: the primary key.
-- (user_id, entity, entity_id, key)

-- The lookups: children by source, parents by destination, a note's blocks
-- by notes_id, the notes by type. Partial, so `text` and props stay out.
CREATE INDEX events_log_cache_by_value ON events_log_cache (user_id, key, value)
  WHERE key IN ('source_id', 'destination_id', 'notes_id', 'type');

-- What changed since a seq: the old row endpoints while they are served
-- from the cache (section 10), the append's watermark catch-up (section 3),
-- and diagnostics. Replaces delta_mat_values_seq.
CREATE INDEX events_log_cache_seq ON events_log_cache (user_id, seq);
```

The reads, and the index each takes:

| read                                  | statement shape                                                                                      | index                  |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------- |
| one block, one link                   | `WHERE user_id = :tenant AND entity = ? AND entity_id = ?`                                           | primary key            |
| many by id                            | `FROM json_each(?1) AS j JOIN events_log_cache c ON c.entity_id = j.value`, or `IN (…)` under 80 ids | primary key            |
| children of a block, in order         | `key = 'source_id' AND value = json_quote(?)` → link ids → their `sort_key` and `deleted` rows       | by-value, then PK      |
| parents of a block                    | `key = 'destination_id' AND value = json_quote(?)`                                                   | by-value, then PK      |
| a note's blocks (`notes_id`)          | `key = 'notes_id' AND value = json_quote(?)`                                                         | by-value, then PK      |
| the notes                             | `key = 'type' AND value IN ('"note"', '"board"', '"tracker"')`                                       | by-value, then PK      |
| a subtree, a closure                  | a recursive CTE whose step is the children read, with the `deleted` row joined at each hop           | by-value, then PK      |
| the whole corpus (a snapshot, verify) | `WHERE user_id = :tenant ORDER BY entity, entity_id, key`, paged by the key                          | primary key            |
| rows since a seq                      | `WHERE user_id = :tenant AND seq > ?`                                                                | `events_log_cache_seq` |

`worker/query-plans.test.ts` keeps its rule for the new table: every
statement a bounded read issues must reach `events_log_cache` through an
index that narrows on more than the tenant. The closure stays the outer
side of every join (`CROSS JOIN`), as it is today.

The guard (`src/data/sql-tenancy-guard.ts`) names `events_log_cache` in
place of `nodes` and `link`, and its tombstone rule becomes: a read of the
cache that assembles an entity must say what it means about the `deleted`
row. `scripts/check-queries.ts` refuses an `INSERT`, `UPDATE` or `DELETE`
on `events_log_cache` outside `worker/handlers/event-log.ts`, as it refuses
one on `nodes`, `link` and `views` today.

## 3. The append writes the cache in the same batch

`planKeyChunk` (`worker/handlers/event-log.ts`) writes eight statements per
chunk today: the log insert, the keys upsert, then insert-created and
update-changed for each of three tables. It becomes **two**:

1. The log insert, as it is: one `INSERT … SELECT FROM json_each(?1)`,
   `seq` assigned in SQL, `ON CONFLICT (user_id, id) DO NOTHING`.
2. One upsert of the run's winners into the cache, from `json_each` of the
   winners (`stampedKeyChanges` already works them out: per key, the
   highest-stamp row of the run). It is `KEY_WINNERS_UPSERT` widened to
   every register: `ON CONFLICT (user_id, entity, entity_id, key) DO UPDATE
SET value, hlc, seq, updated_at … WHERE excluded.hlc > events_log_cache.hlc`.
   Each row's `seq` is read from the log by the event's id
   (`events_log_id`, one seek per row).

The stale check stays and gets simpler. `readCurrent` reads the cache rows
of the entities the push names (one `json_each` join on the primary key)
and `staleKeyEvents` drops an event whose key already holds a stamp at
least as high. There is no `stamps` JSON to parse and no `heldStampOf`
rule: a key with no row has the empty stamp, so any set of it lands.

The upsert is idempotent by itself (a stamp applied twice changes nothing),
so the append-id bookkeeping of today's projection (`INSERTED_BY_THIS_APPEND`,
`notJustInserted`) goes.

**The watermark.** `meta` gains `cache_seq` per tenant: the `seq` of the
last log row the cache has projected, written in the append's batch. Before
the upsert, the append projects every log row above it that is not in the
run (`seq > cache_seq`, by the primary key of `events_log`): normally none.
It costs one `meta` read per write, and it closes the deploy window of
section 10, where a Worker from before this change appends to the log and
not to the cache. It is NOT the reconcile step 1 removed: that one scanned
the whole log four times to find rows outside the log. This one seeks one
key and reads the rows above it, which is empty after the first write.

The row door (`writeRows`: MCP, shares) is unchanged in shape. It reads
the entities it names from the cache, derives events (`rowsToEvents`,
`expandAgainst`), and appends them through the same two statements.

## 4. Sync is the log, and nothing else

- **Push.** `PUT /api/replica/events`, as today: the device's unpushed key
  events, in the order made. Answered with each event's `seq`.
- **Pull.** `GET /api/replica/events-log?since=<seq>&limit=2000`, as today:
  the log past the device's cursor, in pages. Each page is one transaction
  on the device: append to `events_log`, upsert the cache rows, patch the
  graph (section 8). The cursor moves to the page's last `seq`.
- **The row pull is gone.** `GET /api/replica/notes` (full and `?since=`)
  and the browser's row push (`PUT /api/replica/notes`) retire for browsers
  (section 10 says when). A quiet sync is one request that reads one row.
- **A new device** gets one snapshot of the cache, then the log:
  1. `GET /api/replica/cache?after=<entity>|<entity_id>|<key>&limit=20000`.
     The first page reads `meta.cache_seq` and then the rows, in one batch
     (one transaction), and every page answers that `seq`. Pages are keyed
     by the primary key, never by offset, so a row written between pages is
     either in a later page or in the log past `seq`. Cache rows are never
     deleted, so a keyset page misses nothing.
  2. The device writes each page straight into its cache (an insert, no
     stamp check: the table is empty) and draws the graph after the last
     page.
  3. The device sets its log cursor to 0 and pulls the whole log in pages
     behind the screen, as today. Every event up to `seq` lands on a row
     that already holds a stamp at least as high, so it changes nothing;
     every event past `seq` lands as on any cache row. The log is pulled
     for history (the calendar folds a day from it), not for the state.
     The fold check waits until the cursor passes `seq` (`logBehind`).

  On production that is 2 pages of the cache (2.3 MB) and 24 pages of the
  log. At 10x it is 15 pages and 234 pages. Whether a new device needs the
  whole log is an open question (section 11).

## 5. Every server reader moves to the cache

Each reader today, with its file, what it reads, and what it reads after.
"Assemble" means: group an entity's rows and build its `NodeRow` or
`LinkRow` in TypeScript, in one shared module (`src/data/cache-rows.ts`,
proposed) that the Worker and the browser both use. The SQL side of that
is `GROUP BY entity, entity_id` with `json_group_object(key, json(value))`,
one row per entity; `nodePropsSql` (`src/data/node-props-sql.ts`) goes,
because the props are keys in the same object.

| reader                                                | file                                 | reads today                                            | reads after                                                                                                                                  |
| ----------------------------------------------------- | ------------------------------------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Full pull `corpusPullFull`                            | `worker/handlers/replica-corpus.ts`  | every `nodes`, `link`, `views`, `delta_mat_values` row | Becomes the cache snapshot of section 4 (`GET /api/replica/cache`). The row shape is served from the cache only in the window of section 10. |
| Since pull `corpusPullSince`                          | `worker/handlers/replica-corpus.ts`  | rows with `seq > ?` in all four tables                 | Gone for browsers. In the window: entities with a row at `seq > ?` (`events_log_cache_seq`), assembled.                                      |
| Status `corpusStatus`                                 | `worker/handlers/replica-corpus.ts`  | counts over `nodes` and `link` with two joins          | Counts over `deleted` rows: live blocks, live links with both ends live (two PK seeks per link), pages by `type`.                            |
| Held rows for a write `readCurrent`                   | `worker/handlers/event-log.ts`       | `nodes`, `delta_mat_values`, `link`, `views` by id     | The named entities' rows by primary key (`json_each` join). Stamps are the rows' `hlc`.                                                      |
| Projection `planKeyChunk`                             | `worker/handlers/event-log.ts`       | writes 7 statements over the three tables and the keys | Section 3: the log insert and one cache upsert.                                                                                              |
| `seedDeltaMatValues`                                  | `worker/handlers/event-log.ts`       | the whole key log, in memory                           | Removed. The migration backfills every tenant once.                                                                                          |
| Verify `verifyLog`, `legacyReader`                    | `worker/handlers/event-log.ts`       | every row of all tables, the key rows, the whole log   | The whole log (paged, 5,000 rows a page) folded by stamp, against every cache row (paged by the key). No `legacy`, no `mirror`.              |
| `corpusAt` (`GET /api/replica/at`)                    | `worker/handlers/event-log.ts`       | the log only                                           | Unchanged.                                                                                                                                   |
| `restoreSubtree` (`POST /api/replica/restore`)        | `worker/handlers/event-log.ts`       | the log; appends through the projection                | Unchanged, through the new projection.                                                                                                       |
| Old-shape push `appendClientEvents` (`v: 1` clients)  | `worker/handlers/event-log.ts`       | held rows                                              | The cache, through `readCurrent`. Retired with the row endpoints.                                                                            |
| MCP whole graph `loadSnapshot`                        | `worker/mcp/graph-access.ts`         | every live `nodes` and `link` row                      | Every entity assembled by `GROUP BY`, live ones kept. Still O(corpus): writes and `search` use it, as docs/mcp-server.md §4 says.            |
| MCP `nodesByIds`                                      | `worker/mcp/graph-load.ts`           | `nodes` by id, 80 a statement                          | Rows by primary key, 80 ids a statement, assembled.                                                                                          |
| MCP `noteNodes`                                       | `worker/mcp/graph-load.ts`           | `nodes_tenant_type`                                    | `key = 'type'` on the by-value index, then the notes' rows.                                                                                  |
| MCP `nodesWrittenIn`                                  | `worker/mcp/graph-load.ts`           | `nodes_tenant_notes`                                   | `key = 'notes_id'` on the by-value index, then the rows.                                                                                     |
| MCP `linksFrom`, `linksBelow`, `linksAbove`           | `worker/mcp/graph-load.ts`           | `link_tenant_source`, `link_tenant_destination`, joins | The children or parents read of section 2; the recursive CTEs keep their shape with the `deleted` row joined at each hop.                    |
| MCP `scopeNodeIds`                                    | `worker/mcp/graph-load.ts`           | the three walks above, seeded at the grant             | The same, over the by-value index.                                                                                                           |
| MCP `search`                                          | `worker/search/engine.ts`            | no SQL: the scoped graph                               | Unchanged. It reads what `graph-access.ts` loads.                                                                                            |
| Share closure `closureCte`, `closureIds`, `sliceRows` | `worker/shares/slice.ts`             | the recursive walk over `nodes` and `link`             | The same walk over the by-value index, the closure as the outer side. The owner's `view` lookup is the root's id after remove-views.         |
| Share `takenIds`                                      | `worker/shares/slice.ts`             | `nodes` by id, tombstones included                     | `deleted` rows by primary key: a row at all means the id is taken.                                                                           |
| Share `ownsNode`                                      | `worker/handlers/shares.ts`          | `nodes` by id, live                                    | The `deleted` row by primary key, value `null`.                                                                                              |
| Share `ensureView`                                    | `worker/handlers/shares.ts`          | `views` by id                                          | Gone with remove-views.                                                                                                                      |
| MCP token note scope `ownPageIds`                     | `worker/handlers/mcp-tokens.ts`      | `nodes` by id and type                                 | `type` and `deleted` rows by primary key, two seeks per id.                                                                                  |
| Row shapes `toNodeRow`, `toLinkRow`                   | `worker/handlers/replica-payload.ts` | a `nodes` or `link` row                                | Kept as the wire and in-memory types; built by the assembler.                                                                                |
| Rows-read alarm `ROWS_READ_WARN`                      | `worker/d1-sql-driver.ts`            | logs a statement over 5,000 rows                       | The snapshot and verify read 28,081 rows at 1x. They mark their statements exempt; the alarm stays for everything else.                      |
| Plan guard                                            | `worker/query-plans.test.ts`         | `nodes` and `link`                                     | `events_log_cache`.                                                                                                                          |

No other module in `worker/` reads `nodes` or `link` (checked with grep on
2026-10-28: `board-notes.ts`, `board-tag.ts`, `admin.ts`, `social.ts`,
`ai.ts` and `images.ts` read none).

## 6. The D1 limits each reader hits

D1's limits (developers.cloudflare.com/d1/platform/limits, read 2026-10-28)
and the Workers runtime's memory limit. D1 also caps a compound `SELECT` at
5 terms (`SQLITE_LIMIT_COMPOUND_SELECT`); `node:sqlite` in the tests has no
such cap, so a test pins the term count of every statement, as
`event-log.test.ts` does today.

| limit                         | value                | who hits it, and what the design does                                                                                                                                                       |
| ----------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bound parameters per query    | 100                  | Every `IN (…)` reader: `nodesByIds`, `takenIds`, `ownPageIds`, the fold check's reads. They chunk at 80 ids (`CHUNK`), `:tenant` takes one. Longer lists go through `json_each(?1)`.        |
| String, BLOB or row size      | 2 MB                 | The append: a push's events travel as ONE bound JSON. Runs are cut at 750 KB (`MAX_PARAM_BYTES`). The cache upsert's winners JSON is cut with them.                                         |
| SQL statement length          | 100 KB               | The append's statements are large constants, under the cap. A multi-row `VALUES` upsert (the browser writes 1,000 keys a statement) is not an option on D1: the Worker uses `json_each`.    |
| Queries per Worker invocation | 50 free, 1,000 paid  | The append: 2 statements per chunk, plus the stale read and the `meta` read. A paste of 10,000 events is ~14 chunks = 30 queries. Verify pages the log (10 pages at 1x) and the cache (2).  |
| Query duration                | 30 s                 | The migration's backfill from the log (section 10), a window over every log row: 46,620 at 1x, 4.66 M at 100x. The bench measures it; the fallback is a backfill from the tables.           |
| LIKE or GLOB pattern          | 50 bytes             | Why a link's keys are rows and not a prefix match on `entity_id` (section 1).                                                                                                               |
| Arguments per SQL function    | 32                   | `json_object(…)` with more than 16 pairs. The rollback script's `stamps` rebuild has 7 pairs. `json_group_object` is an aggregate and has no such bound.                                    |
| Compound SELECT terms         | 5                    | The migration's backfill: one `INSERT` per key group (blocks' columns, blocks' props, links), never a `UNION ALL` of ten arms. Genesis 0030 used the same shape.                            |
| Worker memory                 | 128 MB               | The cache snapshot and verify at 100x: 2.8 M rows, 240 MB of text. Both page by the primary key (20,000 rows a page, ~2 MB of JSON). The old full row pull at 100x was ~100 MB and over it. |
| Rows read per day             | 5 M free             | The snapshot: 28,081 rows at 1x, once per new device. A quiet sync reads 1 row; a push reads its entities' rows plus 1. `verify` is a diagnostic, run by hand.                              |
| Time Travel                   | 7 days free, 30 paid | The rollback after `nodes` and `link` are dropped (section 10).                                                                                                                             |

## 7. Drop `nodes`, `link` and the mirror

`nodes` (with its `props` mirror and `stamps`), `link` and `delta_mat_values`
are dropped by a second migration, after the cache has run for a week with
`verify` clean and no bundle from before protocol 3 in use (section 10).
With them go `nodes_tenant_type`, `nodes_tenant_updated`, `nodes_tenant_seq`,
`nodes_tenant_notes`, `link_tenant_source`, `link_tenant_destination`,
`link_tenant_updated`, `link_tenant_seq` and `delta_mat_values_seq`.

Between the two migrations the three tables stay as they are and nothing
writes them. They are the rollback (section 10). The old `events` table and
its triggers are not touched by this plan.

## 8. The client

The device's store (`src/data/sql-note-store.ts`, OPFS) holds `events_log`
(as today), `events_log_cache` (the same shape as the server's, without
`user_id`) and `meta`. `nodes`, `link`, `views`, `delta_mat_values` and the
old `events` table go (schema step v17).

### Boot

One statement builds the graph:

```sql
SELECT entity, entity_id, json_group_object(key, json(value)) AS fields,
       MAX(seq) AS seq, MAX(updated_at) AS updated_at
FROM events_log_cache
WHERE value IS NOT NULL
GROUP BY entity, entity_id
```

One row per entity, 6,141 on production. The assembler (`cache-rows.ts`)
reads each row's `fields`: an entity whose `deleted` is not `null`, or
that has no `deleted` key, drops out; a block becomes a `NodeRow` with its
`props.*` keys gathered into `props`; a link becomes a `LinkRow`. Then
`buildGraphSnapshot` builds the node map, the child links per source sorted
by `sort_key` (destination id tiebreak) and the parent links per
destination, as it does today, and drops a link with a tombstoned end.

The grouping was measured both ways (`node:sqlite`, Finn's tenant, median
of 7; the browser's OPFS is slower, about 4x on today's read: 53 ms in the
browser against 13 ms here):

| boot read                                                 | 1x (28,081 rows)    | 10x (280,810 rows) |
| --------------------------------------------------------- | ------------------- | ------------------ |
| A. every cache row, grouped in JS                         | 92 ms + 40 ms build | 1,210 ms + 458 ms  |
| B. `GROUP BY` in SQL, one row per entity (chosen)         | 43 ms               | 469 ms             |
| C. as A, without the link's three key rows                | 43 ms               | 711 ms             |
| D. today's read: `nodes` + `link` with the props subquery | 13 ms               | 170 ms             |

So the cache costs about 3x today's read at boot: roughly 170 ms in the
browser at 1x, and about 2 s at 10x. At 1x that is fine. At 10x the whole-
graph boot is the wrong design and the lazy reads the store already has
(`childLinksOf`, `parentLinksOf`, `nodesOf`, moved to the cache) are the
answer. That is an open question (section 11), not part of this step.

### Each new event

Local or pulled, one transaction (`driver.batch`):

1. `INSERT` the events into `events_log` (a local event at the next
   `position` with `seq` NULL; a pulled one placed, `ON CONFLICT (id)` as
   today).
2. Upsert one cache row per event, `ON CONFLICT (entity, entity_id, key) DO
UPDATE … WHERE excluded.hlc > events_log_cache.hlc`. A liveness event
   writes the `deleted` row. An event without a stamp (an old one, pulled)
   gets its derived stamp in TypeScript first (`keyEventStamp`). There is no
   read-before-write and no `stamps` JSON: `cacheStatements` and most of
   `src/data/fold-cache.ts` go.
3. `markEventsPushed` (after a push is answered) sets `seq` on the event
   and on its cache row, never backwards, as it does today for
   `delta_mat_values`.

Then the runtime (`src/data/database-mode.ts`) **patches the graph**:

1. Collect the entities the batch named: block ids, and for a link its
   source and destination.
2. Re-read those entities from the cache with the boot statement plus
   `WHERE entity_id IN (…)` (300 ids a statement, as `KEYS_PER_READ`).
3. Copy the graph's three maps (shallow: 6,141 entries at 1x, about 1 ms),
   replace or remove each touched node, and rebuild the child list of each
   touched source and the parent list of each touched destination from the
   links read, sorted by `sort_key`.
4. Re-apply the ops still coalescing (`pendingOps`) on top, as `refreshGraph`
   does today, and set the atom.

Nothing is rebuilt from every row. `refreshGraph`'s whole-graph read runs
only at boot and after a repair. A local op is still applied to the atom at
once by `applyOps` (the screen first); the patch after its flush
reconciles the screen with the cache, which matters only when a pulled
event with a higher stamp landed on the same key meanwhile.

### What else changes

- **The fold check** (`src/data/fold-check.ts`) keeps its first half: for
  each touched entity, the fold of its log rows (`foldOfLog`, the
  `events_log_entity` index) against its cache rows, per key, value and
  stamp both. Its second half (the replica's pulled rows against the cache)
  goes with the row pull; `GET /api/replica/verify` is the server-side
  check.
- **Repair** after a SQL failure rebuilds the cache from the device's own
  log (`foldKeysByStamp` over every row, then one insert per key) or, if
  the log is behind, re-snapshots from the server and replays the unpushed
  tail through the upsert, so a local edit not yet pushed still wins where
  its stamp is higher.
- **The stamp fill** (`fillStampsOnce`) and `applyPull` (the row pull's
  writer, with `upsertNodeStatements`) go.
- **Shared notes** (`src/data/shared-mode.ts`) are unchanged: a slice is
  pulled whole and held in memory.
- **Upgrade of a device**: schema v17 creates the cache and drops the old
  tables; `CACHE_GENERATION` goes to 11, so the device re-snapshots from the
  server (section 4) rather than backfilling locally. Its `events_log`
  stays. Its unpushed events are replayed through the upsert after the
  snapshot.

## 9. Bench plan

The harness exists: `/tmp/bench-scale/bench.ts` runs every request a device
makes through `replica()` on a local miniflare D1 and records `rows_read`
per statement; the clones are under `/home/orca/bench-scale-data/`
(`persist-1x`, `persist-10x`, `persist-100x`: Finn's tenant copied 1x, 10x
and 100x inside one `user_id`, migration 0029 applied; add 0030 and this
step's migration before the runs). The client rollup scripts of this
document are in `/tmp/cache-rollup/` (`rollup.cjs`, `variants.cjs`,
`legacy-diff.cjs`). Run everything through `orca-run --kind test`.

Baselines already measured (2026-10-28, 1x):

| request                     | before step 1   | after step 1 | this step's target                                 |
| --------------------------- | --------------- | ------------ | -------------------------------------------------- |
| idle sync pull, rows read   | 186,526         | 15           | 1 (one log page read that returns nothing)         |
| push of one edit, rows read | 378,961         | 551          | under 100 (the stale read + 1 meta row + 2 writes) |
| row pull, full              | ~300 ms, 969 KB | same         | replaced: the snapshot, 2 pages of 20,000 rows     |
| events-log page of 2,000    | ~860 KB         | same         | same                                               |

To measure, per clone (1x, 10x, 100x), `rows_read`, median ms and bytes:

1. **The migration.** The backfill from the log: wall time per tenant and
   whether 100x stays under 30 s per statement. The equality check against
   the tables (0 differences expected: on production today the fold by seq
   and the fold by stamp agree on every one of 28,236 registers, measured
   with `legacy-diff.cjs`).
2. **Server requests.** Push of one edit; push of a paste of 2,000 events;
   idle sync; the snapshot's first and last page; `verify`; `/at`.
3. **MCP.** `read_note` at depth 1 and 2, `list_notes`, `list_parents`,
   `get_block`, `search`, each against today's `graph-load.test.ts`
   fixture numbers (docs/mcp-server.md §4) and the 1x clone.
4. **Shares.** The slice pull of a 285-block share (docs/scaling-thresholds.md
   measured 329k rows read for it once).
5. **Client, at 1x and 10x only.** The boot rollup (the table in section 8:
   43 ms and 469 ms so far, on `node:sqlite`); the same in the browser over
   OPFS; one local event's transaction and patch; one pulled page of 2,000
   events; the fold check for 10 entities; the re-snapshot of an upgraded
   device.

Pass marks: every server request stays O(what it returns), under the 5,000
rows-read alarm except the snapshot and verify; the 1x boot stays under
today's 3 s cold-start trigger with room to spare; at 10x the boot number
decides the open question on lazy reads.

## 10. Migration order and rollback

Three deploys. The migration numbers are the next free ones after step 1's
0030 and remove-views' drop of `views`; they are written `00NN` here.

### Deploy 1: the cache beside the tables (server)

Migration `00NN_events_log_cache.sql`:

1. `CREATE TABLE events_log_cache` and its two indexes (sections 1 and 2).
2. Backfill from the log: for every `(user_id, entity, entity_id, key)` of
   `events_log` where `entity IN ('block', 'link')`, the row with the
   highest stamp (`hlc`, or the derived stamp spelled as `derivedStamp` and
   migration 0030 spell it), with its `seq` and `at`; liveness rows mapped
   to `deleted` (section 1). A window function per partition, one `INSERT`
   per key group, under five compound terms each. This IS the fold by stamp,
   so the cache equals the fold on day one and `verify` needs no legacy
   rule. The old `delta_mat_values` rows are not read: the log holds every
   key they hold (0028's backfill and 0029's seed).
3. `INSERT INTO meta (user_id, 'cache_seq', MAX(seq))` per tenant.
4. Nothing is dropped. `nodes`, `link` and `delta_mat_values` stay, and the
   new Worker never writes them again.

The Worker of the same deploy: the append of section 3, every reader of
section 5, `GET /api/replica/cache`, `REPLICA_PROTOCOL` 3 accepted. The
browser's row endpoints (`GET` and `PUT /api/replica/notes`) are served
from the cache for protocol-2 bundles during this deploy: the full pull
assembles every entity, the since-pull assembles the entities with a row
at `seq > ?` (the `events_log_cache_seq` index), the row push goes through
`writeRows` as it does for MCP. So a tab that has not reloaded keeps
working.

**The deploy window.** `npm run deploy` applies the migration before it
uploads the Worker. For those seconds the old Worker appends to the log and
to the old tables, not to the cache. The watermark closes it: the new
Worker's first write for that tenant projects every log row above
`cache_seq` (section 3). No reconcile, no flag.

**Rollback of deploy 1.** Redeploy the previous Worker. It reads `nodes`,
`link` and `delta_mat_values`, which are stale by everything written since
the deploy. Before the redeploy, run `scripts/rollback-00NN.sql` by hand in
the D1 console: it rebuilds the three tables from the cache (one `INSERT …
ON CONFLICT DO UPDATE` per table from `GROUP BY entity, entity_id`, the
`stamps` column as `json_object` of the key stamps with `legacy` NULL, and
`delta_mat_values` from the `props.*` rows). The previous Worker then
projects from where the cache left off, because every row's `seq` is its
last event's. The cache stays in place, unread, until this step is
redeployed; its watermark catches up then.

### Deploy 2: the client

Schema v17 (create the cache, drop `nodes`, `link`, `views`,
`delta_mat_values`, `snapshots`, `events`), `CACHE_GENERATION` 11 (the
device re-snapshots), the boot, the write path, the patch, the fold check
without the replica half, `REPLICA_PROTOCOL` 3. The push and the log pull
do not change on the wire.

**Rollback of deploy 2.** Redeploy the previous bundle. It is a protocol-2
client; deploy 1 serves it from the cache. Its local schema is v17 and it
expects v16 tables: the ladder refuses a schema above its own, wipes the
store and re-pulls, as it does for any store from the future
(`ensureCorpusSchema`). Nothing is lost on the server; unpushed events of
the v17 store are lost on the device, which is the same risk as any wipe
and is why deploy 2 waits for deploy 1 to settle.

### Deploy 3: the drop

A week or more after deploy 2, with `verify` clean for every tenant and
the protocol-2 bundles gone from use (the Worker logs the protocol of each
request): raise `MIN_REPLICA_PROTOCOL` to 3 in the dashboard first; then
the migration `00NN+1_drop_projection_tables.sql` drops `nodes`, `link`,
`delta_mat_values` and their indexes (section 7), and the same Worker
removes the row endpoints for browsers and `appendClientEvents`. `writeRows`
stays for MCP and shares.

**Rollback of deploy 3.** None by code. The tables are gone; the previous
Worker cannot run. The recovery is D1 Time Travel to before the migration
(7 days free, 30 paid), which also rewinds every write since, or the
rollback script of deploy 1 run against the restored schema. That is why
the drop waits a week and runs last.

### Never

- Never rewrite or delete a row of `events_log`. The migration reads it.
- Never write `events_log_cache` outside `worker/handlers/event-log.ts`
  (`check:queries` enforces it).
- Never roll a Worker back past deploy 1 without the rollback script.

## 11. Open questions for Finn

1. **Plan.** Is production on the free or the paid D1 plan? It sets the
   queries per invocation (50 or 1,000), the daily rows read (5 M) and
   Time Travel (7 or 30 days), and so the rollback window of deploy 3.
2. **A new device and the log.** Does a new device pull the whole log
   (24 pages at 1x, 234 at 10x) for history, or only the cache plus the
   log of the last N days, with older history read from the server on
   demand? This document says the whole log, behind the screen.
3. **The boot at 10x.** About 2 s in the browser by this measurement.
   Accept it for now, or make the graph atom lazy (expand reads
   `childLinksOf`) in a step of its own?
4. **The deploy window.** Serve the row endpoints from the cache for a week
   (this document), or raise `MIN_REPLICA_PROTOCOL` at deploy 1 and make
   every open tab reload?
5. **The backfill source.** From the log's fold by stamp (this document;
   0 differences from the tables today), with the tables as the fallback
   if 100x breaks the 30 s query limit. Confirm.
6. **The liveness key.** `deleted` (as asked), holding `null` or the
   tombstone ms. The stamp name today is `alive`. Confirm the name.
7. **`updated_at` of an entity** as `MAX(updated_at)` over its rows
   (section 1). Confirm.
8. **The client's old `events` table.** Unread since schema v15. Drop it in
   v17 (this document), or keep it?
9. **`kind`.** Every link on production is `child`. Keep `kind` in the
   link's id and as a row (this document), for the edge kinds the schema
   reserved?

10. **A delete implies its links are dead.** Section 12 recommends it: a
    block delete writes only the block's `deleted` key, links are retained,
    and every reader drops a link with a dead end. Confirm.

## 12. A delete implies its links are dead (Finn, 2026-10-28)

Finn asked: "Do we need to delete the link? We can just leave the link
hanging and discard it in the rollup?" This section evaluates the rule
**a delete of a block implies its links are dead**: the delete writes only
the block's `deleted` key, and the client rollup and every server reader
drop a link whose source or destination is deleted.

### Today

- `deleteBlockOps` (`src/data/ops.ts`) writes one `unlink` per parent link
  from outside the deleted set, then the `delete`, then `strandedBlankOps`.
  `deleteSubtreeOps` does the same for a subtree. In the log that is one
  link `delete` per parent plus the block `delete`: 98 of the 175 block
  delete batches on production carry a link delete beside the block's.
- `deleteNoteOps` writes **deletes only**. It leaves every link in place,
  and `restoreNoteOps` (`src/data/deleted-notes.ts`) depends on that: it
  re-links a restored note along the links that were kept. So the rule
  Finn proposes is already in force for notes, and the readers already
  live with it: production holds 184 live links with a tombstoned end.
- Every reader already drops a link with a dead end. `buildGraphSnapshot`
  skips it (docs/graph-storage.md, "Read-time discard, never write-time
  cascade"). The client's lazy reads (`LIVE_LINKS`) exclude it in SQL. The
  MCP loaders join the far node with `deleted_at IS NULL` at every hop
  (`linksFrom`, `linksBelow`, `linksAbove`, `scopeNodeIds`). The share
  closure joins `nodes c … AND c.deleted_at IS NULL` at every hop and
  `sliceRows` keeps only links with both ends in the closure. `corpusStatus`
  joins both ends. `search` reads the in-memory snapshot.
- `applyOps` on the in-memory graph already treats a `delete` this way: "a
  deleted node takes its links out of the snapshot with it, exactly as
  read-time discard would".

So the unlinks a block delete writes are redundant for every reader. They
exist for the log: they say "X left P" in so many words.

### The rule, point by point

**The filter or join in each reader.** Nothing new. Each reader keeps the
far-end check it has today, moved to the cache: the children read of
section 2 reads the link's `deleted` row and the destination's `deleted`
row, one primary-key seek each per child. The parents read does the same
on the source. A recursive walk joins the `deleted` row of the node at each
hop, as it joins `nodes.deleted_at` today. The client rollup drops a link
whose end is missing from the live node map, as `buildGraphSnapshot` does.
The one invariant, stated once in `cache-rows.ts` and pinned by a test:
**a link is drawn only when its own `deleted` is `null` and both ends'
`deleted` are `null`.** Under the rule this invariant is the whole
definition of a dead link, so a reader that forgets the far-end check is a
bug the tests catch, not a slow leak as it is today.

**Dead link rows in the cache.** Rows are never deleted either way. Under
the unlink rule a deleted block's parent links are tombstoned rows; under
this rule they are live rows into a dead block. Both cost 5 rows per link
and both are read by the children read of the parent and dropped. The
count is the same: one row set per link ever made. No compaction. The rows
into a dead block are the positions a restore puts it back into, which is
the reason docs/graph-storage.md gives for retaining them.

**A concurrent link to a deleted block.** Device A deletes X. Device B,
offline, pastes X as a link under P2 (`link` op: a link `create`). Both
land. Under both rules the link P2→X is live and X is dead, so nothing
shows it. Under this rule a later restore of X shows it under P2 and under
its old parents; under the unlink rule only under P2, because the old
parent links were tombstoned and a plain revive of X does not revive them.
A concurrent reorder of P→X on B (`set sort_key`) is a different key from
the link's `deleted`, so it lands on the link row under both rules; under
this rule the link stays live and the sort key counts when X comes back.

**Undo and restore of a deleted block.** Under this rule a deleted block
comes back with one event: a `restore` (or a `create`) of the block, and
every link it had is live and in place. Under the unlink rule an undo
needs the inverse batch, one link revive per old parent, worked out
against the graph as it stood (`src/hooks/board.ts`, `undoable`, does
this for a board's deletes). The server's `/restore` (`planRestoreSubtree`)
restores each link that differs between then and now; under this rule the
parent links do not differ, so it writes fewer events and the result is
the same. A block removed from the outline earlier (an `unlink` through
`docToOps`) stays out: that link was tombstoned in its own right. A "Recently
deleted" list for blocks, like the one for notes, becomes the same walk.

**The delete-rescue of children.** `strandedBlankOps` works on the
in-memory parent index after the batch's own ops: a deleted block's child
links count as gone (`loosen`), a blank child nothing else holds is
deleted, a child with content goes to the basket by reachability. None of
that reads the parent links of the deleted block, so it is unchanged. The
basket itself is reachability from the notes (`unassignedIds`), which
already ignores a dead parent.

**History and the calendar.** The log loses the explicit "X left P" rows.
A day's diff (`src/data/day-changes.ts`) folds before and after and walks
each note, so a deleted block drops out of the walk either way and is
marked as removed. The link's own history (`GET /events?entity=link`) no
longer shows a delete for a block delete; it shows the block's.

**What changes in code, if adopted.** `deleteBlockOps` and
`deleteSubtreeOps` stop writing unlinks (the `delete` of a link stays, for
`docToOps`'s remove-a-row and the basket's unlink). The MCP `delete_block`
tool (`worker/mcp/tools.ts`) uses the same functions. Their tests change.
One test pins the invariant above on the assembler, the children read and
the recursive walks. Nothing in the migration changes: the backfill carries
the tombstoned links as they are.

### Trade-offs

| for the rule                                                                   | against the rule                                                                  |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| One event per deleted block, not one per parent plus one                       | The log no longer says "X left P" for a delete; a reader infers it from the block |
| Undo and restore are one event, and the block comes back in every place it was | A reader that reads links alone must check both ends (it must today, for notes)   |
| Notes and blocks delete by one rule; `restoreNoteOps` is the model             | Link rows into dead blocks stay live in the cache (today they stay as tombstones) |
| Every reader already does the far-end check                                    | One more `deleted` seek per child in the children read (today a `nodes` join)     |

### Recommendation

Adopt the rule. A delete writes the block's `deleted` key and nothing else.
Links are retained, live, and every reader drops a link with a dead end by
the one invariant above. The readers already pay for that check, the note
delete already works this way, and the restore path gets simpler. Keep
`unlink` for removing a row from the outline, which is a different act
(the block survives in the basket). No compaction. Finn confirms in
section 11, question 10.

## Decisions in one list

- Two tables, same shape on the server and on every device: `events_log`
  and `events_log_cache`, one row per `(entity, entity_id, key)`.
- Liveness is a key, `deleted`. An entity with no `deleted` row is not live.
- A link's three fixed keys are rows, used only through the by-value index.
- Two indexes beside the primary key: a partial by-value index on the four
  lookup keys, and a `seq` index.
- The append is two statements: the log insert and one upsert by stamp.
  A `cache_seq` watermark in `meta` closes the deploy window.
- Sync is the log. A new device takes one keyset-paged snapshot of the
  cache, then the log from 0 behind the screen.
- Every server reader assembles entities from cache rows in one shared
  module; the SQL rollup is `GROUP BY` with `json_group_object`.
- The backfill is the fold of the log by stamp, so `verify` compares the
  cache with the fold and needs no legacy rule.
- The old tables stay unwritten for a week, with a hand-run rollback
  script, and are dropped in a third deploy after `MIN_REPLICA_PROTOCOL`
  rises.
- The client boots from one `GROUP BY` statement and patches only the
  touched entities after each batch.
- A delete of a block writes only its `deleted` key. Its links stay live
  and every reader drops a link with a dead end (section 12, recommended).
