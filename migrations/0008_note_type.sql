-- Migration number: 0008    2026-09-12
--
-- The stored note-root type value: `page` → `note`.
--
-- A note's root node has carried `type = 'page'` since before notes were
-- notes. The identifiers around it moved to "note" already (`NOTE_TYPE`,
-- `noteDoc`, `noteIds`…), deliberately leaving the stored value alone because
-- it is sitting in production D1 and in every device's local SQLite. This
-- migration finishes the job: the value itself becomes `note`, so the column
-- reads the way the code and the docs do and there is no last piece of the old
-- vocabulary left to explain.
--
-- Unlike 0001/0002/0004/0005/0006 this file is D1-only: it is NOT part of the
-- corpus ladder the browser store and the worker test driver apply
-- (src/data/corpus-schema.ts), which is DDL only and never rewrites rows.
--
-- ## `seq` is advanced; `updated_at` is not
--
-- 0005 split one column into two on purpose: `seq` is DELIVERY (a
-- server-assigned, per-tenant ordering that makes `seq > cursor` an exact
-- incremental pull), `updated_at` is INTENT (wall-clock last-writer-wins on
-- the upsert). This rewrite is a change that has to be delivered, so it takes
-- a sequence value like any other write — and then every device picks it up on
-- its next ordinary since-pull, roughly one row per note, instead of needing
-- its whole corpus back.
--
-- It is emphatically NOT a claim about whose edit is newer, so `updated_at`
-- stays exactly as it was. Stamping it now would let this migration win a
-- last-writer-wins conflict against a real edit that a device wrote before the
-- deploy and has not pushed yet.
--
-- The arithmetic, in 0005's register: each rewritten row gets the tenant's
-- current maximum `seq` — taken across BOTH tables, since the sequence spans
-- them — plus its `rowid`. Within a tenant that is distinct (rowids are) and
-- strictly above every `seq` already there, so it is above any cursor a client
-- of that tenant can be holding, and no existing row's value is reused. The
-- maxima are materialized into a scratch table FIRST, so the `UPDATE` never
-- reads the column it is in the middle of writing.
--
-- ## What is dangerous about it
--
-- 1. **It is a one-way rewrite of live rows.** There is no `page` left
--    afterwards to tell a `note` that used to be one from a `note` that was
--    minted as one. Take a D1 export first if you want a way back; the inverse
--    (`UPDATE nodes SET type = 'page' WHERE type = 'note'`) is only correct
--    while no client has written a genuine `note` row.
--
-- 2. **An old client cannot survive it.** A bundle that still asks for
--    `type = 'page'` pulls these rows, matches nothing, and shows ZERO notes
--    while its blocks sit in the store unreachable. That is what the replica
--    protocol gate is for: `REPLICA_PROTOCOL` goes to 2 and the Worker's
--    minimum with it, so an old client is refused with `409 client_too_old`,
--    stops syncing and says so, instead of drifting silently.
--
--    The gate only helps if it is CLOSED FIRST. `npm run deploy` applies
--    migrations before it uploads the bundle, so running this migration as
--    part of a deploy leaves a window in which the data has changed and the
--    old Worker — the one without the raised minimum — is still serving. Raise
--    `MIN_REPLICA_PROTOCOL` to 2 in the Cloudflare dashboard (it is a var so
--    that it can be raised without a deploy), THEN apply this, THEN deploy.
--
-- 3. **It moves every note row to the head of the sequence.** Deliberate (see
--    above), but it means the first pull after the deploy carries one row per
--    note on every device, and that those rows sort after everything else a
--    device has seen. Neither matters at this corpus size; both would want
--    thinking about at a much larger one.
--
-- Tombstoned rows are rewritten too (no `deleted_at IS NULL` filter): a
-- restore must bring a note back as a note, and a tombstone replicates like
-- any other row, sequence value included.
--
-- Migrations are history. The earlier files keep saying `page` — 0006's
-- backfill in particular reads `WHERE p.type = 'page'`, and on a fresh
-- database it replays BEFORE this file, so it has to describe the world as it
-- was.

-- The tenant's high-water mark, per tenant, across both tables. Materialized
-- rather than computed inside the UPDATE: a correlated `MAX(seq) FROM nodes`
-- would be reading the column the same statement is rewriting, and SQLite
-- makes no promise about what it would see. Dropped again at the end; the
-- leading DROP is so a partially-applied run can simply be re-run (the UPDATE
-- itself is idempotent — after it there is no `page` row left to match).
DROP TABLE IF EXISTS note_type_seq_base;

CREATE TABLE note_type_seq_base AS
  SELECT user_id, MAX(seq) AS base
    FROM (SELECT user_id, seq FROM nodes
          UNION ALL
          SELECT user_id, seq FROM link)
   GROUP BY user_id;

UPDATE nodes
   SET type = 'note',
       seq = (SELECT base FROM note_type_seq_base b WHERE b.user_id = nodes.user_id) + nodes.rowid
 WHERE type = 'page';

DROP TABLE note_type_seq_base;
