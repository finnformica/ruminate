import { describe, expect, it } from "vitest"
import {
  cacheRowOf,
  cacheRowKey,
  cacheWinners,
  foldCacheRows,
  foldEventsToCache,
  groupCacheRows,
  groupedEntity,
  isCreated,
  isLive,
  linkRowOf,
  nodeRowOf,
  registerOf,
  rowsOfEntities,
  type CacheRow,
} from "./cache-rows"
import { encodeHlc } from "./hlc"
import type { KeyEvent } from "./key-events"

const stamp = (ms: number, device = "a.1") => encodeHlc({ ms, counter: 0, device })

let n = 0
const event = (
  entity: "block" | "link" | "view",
  id: string,
  action: KeyEvent["action"],
  key: string,
  value: unknown,
  at: number,
  extra: Partial<KeyEvent> = {},
): KeyEvent => ({
  id: `evt_${(n += 1)}`,
  entity,
  entity_id: id,
  action,
  key,
  value,
  batch: "b",
  device: "a.1",
  at,
  v: 2,
  hlc: stamp(at),
  ...extra,
})

describe("registerOf", () => {
  it("maps a set to its key and JSON value, an unset to a null value", () => {
    expect(registerOf({ action: "set", key: "text", value: "hi", at: 1 })).toEqual({
      key: "text",
      value: '"hi"',
    })
    expect(registerOf({ action: "unset", key: "props.x", value: null, at: 1 })).toEqual({
      key: "props.x",
      value: null,
    })
  })

  it("maps liveness to the deleted key: null while live, else the tombstone's clock", () => {
    expect(registerOf({ action: "create", key: "", value: null, at: 1 })).toEqual({
      key: "deleted",
      value: "null",
    })
    expect(registerOf({ action: "create", key: "", value: 50, at: 1 })).toEqual({
      key: "deleted",
      value: "50",
    })
    expect(registerOf({ action: "delete", key: "", value: null, at: 7 })).toEqual({
      key: "deleted",
      value: "7",
    })
    expect(registerOf({ action: "delete", key: "", value: 9, at: 7 })).toEqual({
      key: "deleted",
      value: "9",
    })
    expect(registerOf({ action: "restore", key: "", value: null, at: 8 })).toEqual({
      key: "deleted",
      value: "null",
    })
  })
})

describe("cacheRowOf and the winners of a run", () => {
  it("gives a view event no row", () => {
    expect(cacheRowOf(event("view", "v", "set", "pinned", true, 1))).toBeNull()
  })

  it("keeps the highest stamp per register, whatever the order", () => {
    const events = [
      event("block", "a", "set", "text", "newer", 20),
      event("block", "a", "set", "text", "older", 10),
      event("block", "a", "set", "type", "h1", 5),
    ]
    const winners = cacheWinners(events)
    expect(winners.map((row) => [row.key, row.value, row.hlc])).toEqual([
      ["text", '"newer"', stamp(20)],
      ["type", '"h1"', stamp(5)],
    ])
  })

  it("folds rows by stamp: a lower stamp never lands, an equal one keeps the first", () => {
    const first = cacheRowOf(event("block", "a", "set", "text", "x", 10)) as CacheRow
    const lower = cacheRowOf(event("block", "a", "set", "text", "y", 5)) as CacheRow
    const equal = { ...first, value: '"z"' }
    const fold = foldCacheRows([first, lower, equal])
    expect(fold.get(cacheRowKey("block", "a", "text"))?.value).toBe('"x"')
  })

  it("derives the stamp of an event without one, and keeps its seq", () => {
    const old = event("block", "a", "set", "text", "x", 10, { hlc: undefined, seq: 4 })
    delete old.hlc
    const fold = foldEventsToCache([old])
    const row = fold.get(cacheRowKey("block", "a", "text"))
    expect(row?.hlc).toBe("000000000000010-0000-seq:000000000000004")
    expect(row?.seq).toBe(4)
  })
})

describe("entities from rows", () => {
  const events = (): KeyEvent[] => [
    event("block", "a", "create", "", null, 1),
    event("block", "a", "set", "type", "note", 1),
    event("block", "a", "set", "text", "A", 1),
    event("block", "a", "set", "props.width", "full", 2),
    event("block", "a", "set", "props.gone", 1, 2),
    event("block", "a", "unset", "props.gone", null, 3),
    event("block", "b", "create", "", null, 1),
    event("block", "b", "set", "type", "text", 1),
    event("block", "b", "set", "text", "B", 1),
    event("block", "b", "set", "notes_id", "a", 1),
    event("block", "b", "delete", "", 9, 9),
    event("block", "held", "set", "text", "no create yet", 1),
    event("link", "a|b|child", "create", "", null, 1),
    event("link", "a|b|child", "set", "source_id", "a", 1),
    event("link", "a|b|child", "set", "destination_id", "b", 1),
    event("link", "a|b|child", "set", "kind", "child", 1),
    event("link", "a|b|child", "set", "sort_key", "a0", 4, { seq: 12 }),
  ]
  /** The cache's rows: the fold of those events, one row per key. */
  const rows = (): CacheRow[] => [...foldEventsToCache(events()).values()]

  it("groups rows into entities, unset keys left out, the highest seq and clock kept", () => {
    const groups = groupCacheRows(rows())
    const a = groups.get("block\x1fa")
    expect(a?.fields).toEqual({ deleted: null, type: "note", text: "A", "props.width": "full" })
    const link = groups.get("link\x1fa|b|child")
    expect(link?.seq).toBe(12)
    expect(link?.updated_at).toBe(4)
  })

  it("reads an entity out as the app's row: props derived, tombstones as deleted_at", () => {
    const groups = groupCacheRows(rows())
    const { nodes, links } = rowsOfEntities(groups.values())
    expect(nodes).toEqual([
      { id: "a", type: "note", text: "A", props: '{"width":"full"}', updated_at: 3 },
      {
        id: "b",
        type: "text",
        text: "B",
        props: null,
        updated_at: 9,
        deleted_at: 9,
        notes_id: "a",
      },
    ])
    expect(links).toEqual([
      {
        source_id: "a",
        destination_id: "b",
        kind: "child",
        sort_key: "a0",
        updated_at: 4,
        seq: 12,
      },
    ])
    expect(rowsOfEntities(groups.values(), { live: true }).nodes.map((row) => row.id)).toEqual([
      "a",
    ])
  })

  it("never reads out an entity no create has reached", () => {
    const groups = groupCacheRows(rows())
    const held = groups.get("block\x1fheld")
    expect(held && isCreated(held)).toBe(false)
    expect(held && isLive(held)).toBe(false)
    expect(rowsOfEntities(groups.values()).nodes.some((row) => row.id === "held")).toBe(false)
  })

  it("reads a grouped SQL row the same way as grouped cache rows", () => {
    const grouped = groupedEntity({
      entity: "block",
      entity_id: "a",
      fields: '{"deleted":null,"props.width":"full","text":"A","type":"note"}',
      seq: 3,
      updated_at: 3,
    })
    expect(nodeRowOf(grouped)).toEqual({
      id: "a",
      type: "note",
      text: "A",
      props: '{"width":"full"}',
      updated_at: 3,
      seq: 3,
    })
    expect(
      linkRowOf(
        groupedEntity({
          entity: "link",
          entity_id: "a|b|child",
          fields:
            '{"deleted":5,"destination_id":"b","kind":"child","sort_key":"a0","source_id":"a"}',
          seq: null,
          updated_at: 5,
        }),
      ),
    ).toEqual({
      source_id: "a",
      destination_id: "b",
      kind: "child",
      sort_key: "a0",
      updated_at: 5,
      deleted_at: 5,
    })
  })
})
