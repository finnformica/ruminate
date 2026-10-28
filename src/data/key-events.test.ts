import { describe, expect, it } from "vitest"
import {
  EVENT_VERSION,
  fold,
  foldByStamp,
  linkEntityId,
  projectRows,
  toGraphSnapshot,
  type EventContext,
  type RuminateEvent,
} from "./events"
import { buildGraphSnapshot } from "./graph"
import { encodeHlc } from "./hlc"
import {
  KEY_EVENT_VERSION,
  KEY_PATTERN,
  assembleLogState,
  assembleStamped,
  canonicalJson,
  coalesceTypingKeys,
  collapseKeyEvents,
  derivedProps,
  expandEvent,
  expandLog,
  foldKeys,
  foldKeysByStamp,
  keyEventProblem,
  opsToKeyEvents,
  parseKeyEvent,
  parseKeyEventsPayload,
  parseStoredKeyEvent,
  propsEqual,
  validateProps,
  type KeyEvent,
} from "./key-events"
import type { Op } from "./ops"

/** A writer of old-shaped events, numbered as the replica would place them. */
function writer(device = "tab") {
  let n = 0
  const make = (
    entity: RuminateEvent["entity"],
    entityId: string,
    action: RuminateEvent["action"],
    patch: object,
    at = 1_000 + n * 10,
  ): RuminateEvent =>
    ({
      id: `evt_${device}_${(n += 1)}`,
      seq: n,
      batch: `b${n}`,
      device,
      at,
      v: EVENT_VERSION,
      entity,
      entity_id: entityId,
      action,
      patch,
    }) as RuminateEvent
  return {
    block: (id: string, props: object | null, type = "text", text = id) =>
      make("block", id, "create", {
        type,
        text,
        props: props === null ? null : JSON.stringify(props),
        notes_id: "note",
      }),
    edit: (id: string, patch: object) => make("block", id, "update", patch),
    setProps: (id: string, props: object | null) =>
      make("block", id, "update", { props: props === null ? null : JSON.stringify(props) }),
    remove: (id: string, deletedAt?: number) =>
      make("block", id, "delete", deletedAt === undefined ? {} : { deleted_at: deletedAt }),
    restore: (id: string, patch: object) => ({
      ...make("block", id, "restore", patch),
      ref_seq: 1,
    }),
    link: (source: string, destination: string, sortKey: string) =>
      make("link", linkEntityId(source, destination), "create", {
        source_id: source,
        destination_id: destination,
        kind: "child",
        sort_key: sortKey,
      }),
    view: (id: string, pinned = true) =>
      make("view", id, "create", { root_id: id, filter: null, sort: null, pinned, sort_key: null }),
  }
}

const shape = (rows: readonly KeyEvent[]) =>
  rows.map(
    (row) =>
      `${row.action} ${row.key}${row.action === "set" ? `=${JSON.stringify(row.value)}` : ""}`,
  )

/** Rows with their ids numbered as a placed per-key log numbers them. */
const placed = (rows: readonly KeyEvent[]): KeyEvent[] =>
  rows.map((row, i) => ({ ...row, seq: i + 1 }))

function context(device = "tab", at = 1_000): EventContext {
  let n = 0
  let ms = at
  return {
    batch: "b1",
    device,
    at,
    tz: 60,
    mintId: () => `evt_${device}_${(n += 1)}`,
    stamp: () => encodeHlc({ ms: (ms += 1), counter: 0, device }),
  }
}

describe("expandEvent", () => {
  it("reads a create as its liveness row, its columns, and one set per props key", () => {
    const w = writer()
    const rows = expandEvent(w.block("a", { title: "T", nested: { x: 1 } }), null)
    expect(shape(rows)).toEqual([
      "create ",
      'set type="text"',
      'set text="a"',
      'set notes_id="note"',
      'set props.nested={"x":1}',
      'set props.title="T"',
    ])
    expect(rows.map((row) => row.id)).toEqual([0, 1, 2, 3, 4, 5].map((i) => `evt_tab_1#${i}`))
    expect(rows[0]).toMatchObject({ event: "evt_tab_1", event_seq: 1, v: KEY_EVENT_VERSION })
  })

  it("reads a whole-props patch against the props before it: changed keys set, gone keys unset", () => {
    const w = writer()
    const rows = expandEvent(
      w.setProps("a", { title: "T2", size: 50, "a.b": true, "bad key": 1 }),
      {
        title: "T",
        font: "serif",
        size: 50,
      },
    )
    expect(shape(rows)).toEqual(["set props.a.b=true", 'set props.title="T2"', "unset props.font"])
  })

  it("reads a null value as no value, a null props as every key gone, and a reorder as nothing", () => {
    const w = writer()
    expect(shape(expandEvent(w.setProps("a", { title: null, k: 1 }), { title: "T" }))).toEqual([
      "set props.k=1",
      "unset props.title",
    ])
    expect(shape(expandEvent(w.setProps("a", null), { title: "T", k: 1 }))).toEqual([
      "unset props.k",
      "unset props.title",
    ])
    expect(expandEvent(w.setProps("a", { k: 1, title: "T" }), { title: "T", k: 1 })).toEqual([])
  })

  it("reads a delete, a restore, a link and a view", () => {
    const w = writer()
    expect(shape(expandEvent(w.remove("a", 500), null))).toEqual(["delete "])
    expect(expandEvent(w.remove("a", 500), null)[0].value).toBe(500)
    const restored = expandEvent(w.restore("a", { text: "back" }), null)
    expect(shape(restored)).toEqual(["restore ", 'set text="back"'])
    expect(restored[0].ref_seq).toBe(1)
    expect(shape(expandEvent(w.link("n", "a", "a0"), null))).toEqual([
      "create ",
      'set source_id="n"',
      'set destination_id="a"',
      'set kind="child"',
      'set sort_key="a0"',
    ])
    expect(shape(expandEvent(w.view("v"), null))).toEqual([
      "create ",
      'set root_id="v"',
      "set filter=null",
      "set sort=null",
      "set pinned=true",
      "set sort_key=null",
    ])
  })
})

describe("the folds", () => {
  const sampleLog = () => {
    const w = writer()
    return [
      w.block("note", { title: "N" }, "note", "N"),
      w.block("a", { align: "left", size: 40 }, "image", ""),
      w.link("note", "a", "a0"),
      w.view("note"),
      w.edit("a", { text: "A!" }),
      w.setProps("a", { size: 60, align: "left", thumbhash: "abc" }),
      w.setProps("a", { size: 60 }),
      w.remove("a"),
      w.restore("a", { text: "back", props: JSON.stringify({ size: 70 }) }),
    ]
  }

  const canonRows = (rows: ReturnType<typeof projectRows>) =>
    JSON.stringify({
      nodes: rows.nodes.map((row) => ({
        ...row,
        props: canonicalJson(JSON.parse(row.props ?? "{}")),
      })),
      links: rows.links,
      views: rows.views,
    })

  it("the per-key reading of an old log folds, by seq, to what the old fold yields", () => {
    const log = sampleLog()
    const keyed = expandLog(log)
    expect(canonRows(projectRows(assembleLogState(foldKeys(placed(keyed)))))).toBe(
      canonRows(projectRows(fold(log))),
    )
    // And by stamp, read out as the old fold by stamp is.
    expect(toGraphSnapshot(assembleStamped(foldKeysByStamp(placed(keyed))))).toEqual(
      toGraphSnapshot(foldByStamp(log)),
    )
  })

  it("two devices offline on two keys of one block both keep their change", () => {
    const w = writer()
    const base = expandLog([w.block("a", { align: "left", size: 40 }, "image", "")])
    const stampedAt = (row: KeyEvent, ms: number): KeyEvent => ({
      ...row,
      hlc: encodeHlc({ ms, counter: 0, device: row.device }),
    })
    // The phone sets the size at 2000; the laptop set the alignment at 1500,
    // and its push arrives last.
    const phone = expandEvent(
      { ...w.setProps("a", { size: 80 }), device: "phone" },
      {
        align: "left",
        size: 40,
      },
    ).map((row) => stampedAt(row, 2_000))
    const laptop = expandEvent(
      { ...w.setProps("a", { align: "right" }), device: "laptop" },
      {
        align: "left",
        size: 40,
      },
    ).map((row) => stampedAt(row, 1_500))
    expect(shape(phone)).toEqual(["set props.size=80", "unset props.align"])
    expect(shape(laptop)).toEqual(['set props.align="right"', "unset props.size"])
    // Per key: each device's set beats the other's unset of its own key only
    // where its stamp is higher — the laptop's older unset of `size` loses,
    // the phone's newer unset of `align` wins. Each key resolves on its own.
    const state = assembleStamped(foldKeysByStamp([...base, ...phone, ...laptop]))
    expect(toGraphSnapshot(state).nodes.get("a")?.props).toBe(JSON.stringify({ size: 80 }))
    // A set to a key the other device did not touch always survives.
    const laptopFont = expandEvent(
      { ...w.setProps("a", { align: "left", size: 40, font: "x" }), device: "laptop" },
      {
        align: "left",
        size: 40,
      },
    ).map((row) => stampedAt(row, 1_500))
    expect(shape(laptopFont)).toEqual(['set props.font="x"'])
    const merged = assembleStamped(foldKeysByStamp([...base, ...phone, ...laptopFont]))
    expect(JSON.parse(toGraphSnapshot(merged).nodes.get("a")?.props ?? "{}")).toEqual({
      size: 80,
      font: "x",
    })
  })

  it("an unset keeps its stamp: an older set of the key that arrives later loses to it", () => {
    const w = writer()
    const rows = expandLog([w.block("a", { k: 1 }), w.setProps("a", null)])
    const stamped = rows.map((row, i) => ({
      ...row,
      hlc: encodeHlc({ ms: 1_000 + i, counter: 0, device: "d" }),
    }))
    const late = expandEvent({ ...w.setProps("a", { k: 2 }), device: "e" }, {}).map((row) => ({
      ...row,
      hlc: encodeHlc({ ms: 999, counter: 0, device: "e" }),
    }))
    const state = assembleStamped(foldKeysByStamp([...stamped, ...late]))
    expect(toGraphSnapshot(state).nodes.get("a")?.props).toBeNull()
  })

  it("the props a state projects to are the live keys, sorted, or null", () => {
    expect(derivedProps({ "props.b": 1, "props.a": "x", text: "t", "props.gone": null })).toBe(
      '{"a":"x","b":1}',
    )
    expect(derivedProps({ text: "t", "props.gone": null })).toBeNull()
    expect(propsEqual('{"a":1,"b":2}', '{"b":2,"a":1}')).toBe(true)
    expect(propsEqual(null, "{}")).toBe(true)
    expect(propsEqual('{"a":1}', '{"a":2}')).toBe(false)
  })
})

describe("collapseKeyEvents", () => {
  it("folds a group of key rows back to the old event it came from, props included", () => {
    const w = writer()
    const create = w.block("a", { title: "T", size: 40 })
    const update = w.setProps("a", { title: "T2", size: 40 })
    const rows = [...expandEvent(create, null), ...expandEvent(update, { title: "T", size: 40 })]
    const { events, eventOf } = collapseKeyEvents(rows, () => null)
    expect(events.map((event) => event.id)).toEqual([create.id, update.id])
    expect(events[0].patch).toEqual({
      type: "text",
      text: "a",
      notes_id: "note",
      props: JSON.stringify({ size: 40, title: "T" }),
    })
    expect(events[1].patch).toEqual({ props: JSON.stringify({ size: 40, title: "T2" }) })
    expect(eventOf.get(rows[0].id)).toBe(create.id)
    expect(eventOf.get(rows.at(-1)!.id)).toBe(update.id)
  })

  it("reads a client's rows against the props the replica holds, and takes the first id", () => {
    const rows = opsToKeyEvents(
      buildGraphSnapshot(
        [{ id: "a", type: "text", text: "A", props: '{"k":1,"j":2}', updated_at: 1, seq: 4 }],
        [],
      ),
      [{ op: "setProps", id: "a", props: '{"k":2}' }],
      context(),
    )
    expect(shape(rows)).toEqual(["set props.k=2", "unset props.j"])
    const { events } = collapseKeyEvents(rows, () => ({ k: 1, j: 2, elsewhere: true }))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      id: rows[0].id,
      action: "update",
      base_seq: 4,
      patch: { props: JSON.stringify({ elsewhere: true, k: 2 }) },
    })
  })
})

describe("opsToKeyEvents", () => {
  const snapshot = buildGraphSnapshot(
    [
      { id: "note", type: "note", text: "N", props: null, updated_at: 1, seq: 1 },
      {
        id: "a",
        type: "text",
        text: "A",
        props: '{"k":1}',
        updated_at: 1,
        seq: 2,
        notes_id: "note",
      },
    ],
    [
      {
        source_id: "note",
        destination_id: "a",
        kind: "child",
        sort_key: "a0",
        updated_at: 1,
        seq: 3,
      },
    ],
  )

  it("folds a block's set ops into the rows of its create, and into one row per key", () => {
    const ops: Op[] = [
      { op: "create", id: "b", type: "text", text: "", props: '{"x":1}', notesId: "note" },
      { op: "setText", id: "b", text: "typed" },
      { op: "setProps", id: "b", props: '{"x":2,"y":3}' },
      { op: "link", source: "note", destination: "b", sortKey: "a1" },
      { op: "setText", id: "a", text: "A!" },
      { op: "setType", id: "a", type: "h1" },
      { op: "setProps", id: "a", props: null },
    ]
    const rows = opsToKeyEvents(snapshot, ops, context())
    expect(rows.map((row) => `${row.entity_id}: ${shape([row])[0]}`)).toEqual([
      "b: create ",
      'b: set type="text"',
      'b: set text="typed"',
      'b: set notes_id="note"',
      "b: set props.x=2",
      "b: set props.y=3",
      "note|b|child: create ",
      'note|b|child: set source_id="note"',
      'note|b|child: set destination_id="b"',
      'note|b|child: set kind="child"',
      'note|b|child: set sort_key="a1"',
      'a: set text="A!"',
      'a: set type="h1"',
      "a: unset props.k",
    ])
    expect(rows.find((row) => row.entity_id === "a")?.base_seq).toBe(2)
    expect(rows.every((row) => typeof row.hlc === "string")).toBe(true)
  })

  it("coalesces a typing run of key rows to its last, keeping the first base", () => {
    const row = (text: string, at: number, base: number | null): KeyEvent => ({
      id: `e${at}`,
      entity: "block",
      entity_id: "a",
      action: "set",
      key: "text",
      value: text,
      batch: "b",
      device: "d",
      base_seq: base,
      at,
      v: KEY_EVENT_VERSION,
    })
    const typed = coalesceTypingKeys([row("x", 1, 4), row("xy", 2, 5), row("xyz", 3, 5)])
    expect(typed).toHaveLength(1)
    expect(typed[0]).toMatchObject({ id: "e3", value: "xyz", base_seq: 4 })
  })
})

describe("validation", () => {
  const good = (): Record<string, unknown> => ({
    id: "evt_1",
    entity: "block",
    entity_id: "a",
    action: "set",
    key: "props.align",
    value: "left",
    batch: "b1",
    device: "dev.tab",
    at: 1_000,
    hlc: encodeHlc({ ms: 1_000, counter: 0, device: "dev.tab" }),
    v: 2,
  })

  it("accepts a well-formed row and refuses the shapes that are not one", () => {
    expect(parseKeyEvent(good())).toMatchObject({ key: "props.align", value: "left" })
    const refused = [
      { ...good(), key: "props.bad key" },
      { ...good(), key: "props." },
      { ...good(), key: "colour" },
      { ...good(), action: "update" },
      { ...good(), action: "set", key: "", value: 1 },
      { ...good(), action: "unset", key: "text" },
      { ...good(), action: "unset", value: 1 },
      { ...good(), action: "create", key: "x" },
      { ...good(), action: "create", key: "", value: "soon" },
      { ...good(), action: "restore", key: "", value: null },
      { ...good(), value: null },
      { ...good(), value: "middle" },
      { ...good(), key: "props.size", value: "wide" },
      { ...good(), key: "text", value: 7 },
      { ...good(), entity: "link", key: "props.x" },
      { ...good(), entity: "link", key: "text" },
      { ...good(), entity: "view", key: "pinned", value: "yes" },
      { ...good(), v: 1 },
      { ...good(), hlc: "not a stamp" },
      { ...good(), tz: 100_000 },
    ]
    for (const raw of refused) expect(parseKeyEvent(raw), JSON.stringify(raw)).toBeNull()
    for (const raw of refused) expect(keyEventProblem(raw)).toEqual(expect.any(String))
    expect(
      parseKeyEvent({ ...good(), key: "props.anything_new", value: { deep: [1] } }),
    ).not.toBeNull()
    expect(
      parseKeyEvent({ ...good(), action: "restore", key: "", value: null, ref_seq: null }),
    ).not.toBeNull()
    expect(KEY_PATTERN.test("d:2026-10-27")).toBe(true)
  })

  it("takes a push whole or not at all", () => {
    expect(parseKeyEventsPayload({ events: [good(), good()], cursor: "c" })).toMatchObject({
      cursor: "c",
    })
    expect(parseKeyEventsPayload({ events: [good(), { ...good(), key: "no such" }] })).toBeNull()
    expect(parseKeyEventsPayload({ events: "x" })).toBeNull()
  })

  it("skips a stored row that does not read as an event, and says so", () => {
    const said: string[] = []
    const row = {
      id: "evt_1",
      seq: 3,
      entity: "block",
      entity_id: "a",
      action: "set",
      key: "props.align",
      value: '"left"',
      batch: "b1",
      device: "dev.tab",
      at: 1_000,
      v: 2,
      event_id: "old_1",
      event_seq: 2,
    }
    expect(parseStoredKeyEvent(row, (m) => said.push(m))).toMatchObject({
      seq: 3,
      value: "left",
      event: "old_1",
      event_seq: 2,
      base_seq: null,
    })
    expect(parseStoredKeyEvent({ ...row, value: "{not json" }, (m) => said.push(m))).toBeNull()
    expect(parseStoredKeyEvent({ ...row, key: "props.bad key" }, (m) => said.push(m))).toBeNull()
    expect(said).toHaveLength(2)
  })

  it("holds a block type's known keys to their shape and other keys to the pattern", () => {
    expect(validateProps("image", { align: "left", size: 50, custom: [1] })).toEqual({ ok: true })
    expect(validateProps("image", { align: "middle" })).toMatchObject({ ok: false })
    expect(validateProps("note", { "bad key": 1 })).toMatchObject({ ok: false })
    expect(validateProps("unknown_type", { anything: 1 })).toEqual({ ok: true })
  })
})
