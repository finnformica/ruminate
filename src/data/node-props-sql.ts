/**
 * A block's `props`, in SQL, from its `delta_mat_values` rows
 * (docs/event-sourcing.md, "The cut-over"; migrations/0029). The `nodes`
 * table holds no `props` column: a block's props are one row per key, and
 * every read of a block derives the column from them — the live keys in
 * sorted order as one JSON object, or NULL for none. That is `derivedProps`
 * (`key-events.ts`) spelled in SQL, so a row read out of either engine
 * spells a block's props as the fold does.
 *
 * `blockId` is the SQL expression that names the block (`n.id`, `nodes.id`,
 * a `json_extract`); `scope` is the shape of the table — the Worker's D1 is
 * column-tenanted and binds `:tenant`, the browser's store is one user per
 * profile and has no `user_id`.
 */
export function nodePropsSql(blockId: string, scope: "tenant" | "single"): string {
  const tenant = scope === "tenant" ? "user_id = :tenant AND " : ""
  return (
    "(SELECT NULLIF(json_group_object(b.key, json(b.value)), '{}') FROM (SELECT key, value " +
    `FROM delta_mat_values WHERE ${tenant}block_id = ${blockId} AND value IS NOT NULL ` +
    "ORDER BY key) AS b)"
  )
}
