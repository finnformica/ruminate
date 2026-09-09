-- Migration number: 0005    2026-09-09
--
-- A server-ordered row sequence, so incremental pulls can be EXACT.
--
-- Until now the since-pull compared `updated_at`, a millisecond timestamp
-- stamped by whichever device wrote the row. Device clocks disagree, so the
-- comparison can miss a row that landed with a slightly-behind stamp — and the
-- client compensated by asking for a ten-minute overlap window on every pull
-- (`SINCE_OVERLAP_MS`, src/data/d1-note-source.ts). That window is why an
-- editing session re-read its own writes for ten minutes after each save:
-- 499k rows in a day, 65% of the account's entire D1 read budget, almost all
-- of it a device being told what it had just written (docs/scaling-thresholds.md).
--
-- `seq` replaces the timestamp for that one job. It is assigned HERE, by the
-- database, inside the same transaction as the write (`planReplicaPut`), from
-- the tenant's current maximum + 1. A cursor is then an integer both sides
-- agree on, `seq > ?` is exact, and no overlap window is needed.
--
-- `updated_at` keeps its OTHER job unchanged: last-writer-wins conflict
-- resolution on the upsert. That genuinely wants wall-clock intent ("whose
-- edit is newer"), which a server sequence cannot express. The two concerns
-- were conflated in one column; this separates them.
--
-- The sequence is shared across `nodes` and `link` and scoped per tenant, so
-- one cursor covers both tables. It is NOT globally unique and does not need
-- to be: `seq > ?` only ever runs inside a single tenant's partition.

ALTER TABLE nodes ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE link ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;

-- Backfill. Existing rows need distinct, stable, increasing values; their
-- exact order does not matter, because every device's stored cursor is a
-- millisecond timestamp and is retired by this change (a legacy cursor
-- degrades to one full pull — src/data/database-mode.ts), so nobody resumes
-- from a backfilled seq. `rowid` gives insertion order for free; offsetting
-- link by the node maximum keeps the two tables in one sequence.
UPDATE nodes SET seq = rowid;
UPDATE link SET seq = (SELECT COALESCE(MAX(seq), 0) FROM nodes) + rowid;

-- The since-pull's index. Leads with the tenant key like every other index
-- here, so a scan cannot wander out of one tenant's partition.
CREATE INDEX nodes_tenant_seq ON nodes (user_id, seq);
CREATE INDEX link_tenant_seq ON link (user_id, seq);
