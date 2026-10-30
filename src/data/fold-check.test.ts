import { describe, expect, it } from "vitest"
import type { CacheRow } from "./cache-rows"
import { cacheRowKey } from "./cache-rows"
import { cacheDifferences } from "./fold-check"

const row = (
  entity: "block" | "link",
  id: string,
  key: string,
  value: string | null,
  hlc: string,
  extra: Partial<CacheRow> = {},
): CacheRow => ({ entity, entity_id: id, key, value, hlc, seq: 1, updated_at: 1, ...extra })

const fold = (...rows: CacheRow[]) =>
  new Map(rows.map((r) => [cacheRowKey(r.entity, r.entity_id, r.key), r]))

describe("cacheDifferences", () => {
  it("reports nothing when every register agrees, whatever the spelling of its value", () => {
    const log = fold(
      row("block", "a", "props.size", '{"w":1,"h":2}', "s1"),
      row("block", "a", "deleted", "null", "s2"),
      row("link", "a|b|child", "sort_key", '"a0"', "s3"),
    )
    const cache = [
      row("block", "a", "props.size", '{"h":2,"w":1}', "s1", { seq: null, updated_at: 9 }),
      row("block", "a", "deleted", "null", "s2"),
      row("link", "a|b|child", "sort_key", '"a0"', "s3"),
    ]
    expect(cacheDifferences(log, cache)).toEqual([])
  })

  it("names a differing value, a differing stamp, and both", () => {
    const log = fold(
      row("block", "a", "text", '"x"', "s1"),
      row("block", "a", "type", '"h1"', "s1"),
      row("block", "a", "props.gone", null, "s1"),
    )
    const cache = [
      row("block", "a", "text", '"y"', "s1"),
      row("block", "a", "type", '"h1"', "s9"),
      row("block", "a", "props.gone", '"back"', "s9"),
    ]
    expect(cacheDifferences(log, cache)).toEqual([
      "block a text: value",
      "block a type: hlc",
      "block a props.gone: value, hlc",
    ])
  })

  it("names a register only one side holds", () => {
    const log = fold(row("block", "a", "text", '"x"', "s1"))
    const cache = [row("link", "a|b|child", "deleted", "null", "s2")]
    expect(cacheDifferences(log, cache)).toEqual([
      "block a text: only in the log",
      "link a|b|child deleted: only in the cache",
    ])
  })
})
