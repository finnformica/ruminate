-- Migration number: 0016    2026-09-20
--
-- Retire `pinned`, `filter` and `sort` from node props.
--
-- 0015 created `views` and copied them in; this removes the originals. It is
-- deliberately a SEPARATE migration, applied with the release whose client
-- reads the table: between the two, both sources exist and either client
-- works. Applying them together would blank every pin for as long as a
-- deployed client was still reading props.
--
-- `updated_at` is bumped so the cleaned row travels on the next incremental
-- pull. Without that, a client still holding the old props would push them
-- back on its next edit to that node and last-writer-wins would restore them.
-- The notes list is ordered by the `updated_at` INSIDE props
-- (docs/metadata.md), which this does not touch, so nothing visibly reorders.

-- Retire the keys. `updated_at` is bumped so the cleaned row travels on the
-- next incremental pull: a client still holding the old props would otherwise
-- push them back on its next edit and last-writer-wins would restore them.
-- The notes list is ordered by the `updated_at` INSIDE props (docs/metadata.md),
-- which this does not touch, so nothing visibly reorders.
UPDATE nodes
SET props = json_remove(props, '$.pinned', '$.filter', '$.sort'),
    updated_at = updated_at + 1
WHERE deleted_at IS NULL
  AND props IS NOT NULL
  AND json_valid(props)
  AND (
    json_extract(props, '$.pinned') IS NOT NULL
    OR json_extract(props, '$.filter') IS NOT NULL
    OR json_extract(props, '$.sort') IS NOT NULL
  );
