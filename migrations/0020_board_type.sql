-- Migration number: 0020    2026-10-06
--
-- A board is a node type of its own. Until now a board was a `note` row whose
-- props carried `board: true` (docs/boards.md); now its root is typed
-- `board`, beside `note`, and the property is retired — the type says what
-- the property said, and nothing beneath the root changes.
--
-- Ships WITH the client that reads the type. `npm run deploy` runs this
-- BEFORE `wrangler deploy` (wrangler.jsonc), so between the two the old code
-- runs against the new rows: it lists no boards, briefly, and a client still
-- on the old build shows none until it refreshes. Nothing is lost in that
-- window — the rows are there, under a type the old code does not know.
--
-- `updated_at` moves by one so the retyped row is the newer one: a client on
-- the new build wipes its cache and pulls this version (`CACHE_GENERATION`,
-- src/data/database-mode.ts), and a stale push from a client on the old build
-- cannot put the old shape back over it (`planReplicaPut` refuses an older
-- `updated_at`; and the replica retypes a legacy board row on the way in,
-- worker/handlers/replica.ts, for the push that is not older).
--
-- Re-runnable: a row already typed `board` is not matched.

UPDATE nodes
SET type = 'board',
    props = json_remove(props, '$.board'),
    updated_at = updated_at + 1
WHERE type = 'note'
  AND props IS NOT NULL
  AND json_valid(props)
  AND json_extract(props, '$.board') = 1;

-- A row left holding `{}` reads as no props, as `NULL` does; make it NULL so
-- the two shapes stay one.
UPDATE nodes SET props = NULL WHERE props = '{}';
