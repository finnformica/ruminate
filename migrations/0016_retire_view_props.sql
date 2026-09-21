-- Migration number: 0016    2026-09-21
--
-- Retire the three view keys from node props: `pinned`, `filter` and `sort`
-- live in `views` now (0015 copied them there). Ships WITH the client that
-- reads the table — applied a release earlier it would blank every pin while
-- the clients still reading props were up.
--
-- `updated_at` moves by one so the cleaned row is the newer one: a client
-- that upgraded wipes its cache and pulls this version (`CACHE_GENERATION`,
-- src/data/database-mode.ts), and a stale push from one that has not cannot
-- put the keys back over it (`planReplicaPut` refuses an older `updated_at`).
-- A later edit from such a client can still carry them — harmlessly, since
-- nothing reads them any more.
--
-- Re-runnable: a row that no longer holds any of the keys is not matched.

UPDATE nodes
SET props = json_remove(props, '$.pinned', '$.filter', '$.sort'),
    updated_at = updated_at + 1
WHERE props IS NOT NULL
  AND json_valid(props)
  AND (
    json_extract(props, '$.pinned') IS NOT NULL
    OR json_extract(props, '$.filter') IS NOT NULL
    OR json_extract(props, '$.sort') IS NOT NULL
  );

-- A row left holding `{}` reads as no props, as `NULL` does; make it NULL so
-- the two shapes stay one.
UPDATE nodes SET props = NULL WHERE props = '{}';
