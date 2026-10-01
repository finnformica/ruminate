import { describe, expect, it } from "vitest"
import { parse } from "../blocks/parse"
import { serialize } from "../blocks/serialize"
import {
  BOARD_FEATURES,
  addImageOps,
  boardFeatures,
  boardImageIds,
  carryingAll,
  clearValueOps,
  featureBlockId,
  imageUploadedOps,
  imageValues,
  inverseOps,
  setCaptionOps,
  setValueOps,
  unassignedImageIds,
} from "./boards"
import {
  buildGraphSnapshot,
  childIdsOf,
  docToGraph,
  noteDoc,
  parentIdsOf,
  type GraphSnapshot,
} from "./graph"
import { applyOps, type Op } from "./ops"
import { unassignedIds } from "./basket"

const NOW = 1000

const LOCATION = BOARD_FEATURES[0]
const FIXTURE = BOARD_FEATURES[1]

/** A graph holding these notes, from canonical markdown. */
function graphOf(notes: Record<string, string>): GraphSnapshot {
  const nodes = []
  const links = []
  for (const [id, markdown] of Object.entries(notes)) {
    // Every note in a fixture is a board: the page carries the property.
    const g = docToGraph(id, serialize(parse(markdown)), 1, { board: true })
    nodes.push(...g.nodes)
    links.push(...g.links)
  }
  return buildGraphSnapshot(nodes, links)
}

const walk = (snapshot: GraphSnapshot, id: string) => {
  const doc = noteDoc(id, snapshot)
  return doc ? serialize(doc) : null
}

const kinds = (ops: Op[]) => ops.map((op) => op.op)

const img = (n: number) => `![](/api/images/img_${String(n).padStart(12, "0")})`

/** A board with two pictures and one feature already on it. The first
 * picture is in Mauritius: linked under that value as well as the page
 * (`boardOf` adds the second parent — markdown cannot say it twice). */
const BOARD = [
  "Location",
  "  id:: blk_location00",
  "  - Mauritius",
  "    id:: blk_mauritius0",
  "  - Lisbon",
  "    id:: blk_lisbon0000",
  img(1),
  "  id:: blk_pic1000000",
  img(2),
  "  id:: blk_pic2000000",
  "",
].join("\n")

const boardOf = (extra = "") =>
  applyOps(
    graphOf({ b: extra + BOARD }),
    [{ op: "link", source: "blk_mauritius0", destination: "blk_pic1000000", sortKey: "a0" }],
    1,
  )

describe("featureBlockId", () => {
  it("matches a direct child by its text, trimmed and whatever its case", () => {
    const snapshot = graphOf({ b: "- location \n  id:: blk_loc0000000\n" })
    expect(featureBlockId(snapshot, "b", LOCATION)).toBe("blk_loc0000000")
    expect(featureBlockId(snapshot, "b", FIXTURE)).toBeNull()
  })

  it("takes the first of two and ignores a deeper one", () => {
    const snapshot = graphOf({
      b: [
        "- Notes",
        "  id:: blk_notes00000",
        "  - Location",
        "    id:: blk_deep000000",
        "- Location",
        "  id:: blk_first00000",
        "- Location",
        "  id:: blk_second0000",
        "",
      ].join("\n"),
    })
    expect(featureBlockId(snapshot, "b", LOCATION)).toBe("blk_first00000")
  })
})

describe("boardFeatures", () => {
  it("lists every feature, with the values of the ones on the page", () => {
    const snapshot = boardOf()
    const state = boardFeatures(snapshot, "b")
    expect(state.map((s) => s.feature.label)).toEqual(BOARD_FEATURES.map((f) => f.label))
    expect(state[0]).toEqual({
      feature: LOCATION,
      blockId: "blk_location00",
      values: [
        { id: "blk_mauritius0", text: "Mauritius" },
        { id: "blk_lisbon0000", text: "Lisbon" },
      ],
    })
    expect(state[1]).toEqual({ feature: FIXTURE, blockId: null, values: [] })
  })

  it("does not read a picture under a feature as a value", () => {
    const snapshot = graphOf({
      b: `Location\n  id:: blk_location00\n  ${img(9)}\n    id:: blk_stray00000\n`,
    })
    expect(boardFeatures(snapshot, "b")[0].values).toEqual([])
  })
})

describe("boardImageIds", () => {
  it("lists the reached pictures in document order, once each", () => {
    const snapshot = boardOf(
      ["# Heading", "  id:: blk_heading000", `  ${img(3)}`, "    id:: blk_pic3000000", ""].join(
        "\n",
      ),
    )
    expect(boardImageIds(snapshot, "b")).toEqual([
      "blk_pic3000000",
      "blk_pic1000000",
      "blk_pic2000000",
    ])
  })

  it("is empty for a note that is not there", () => {
    expect(boardImageIds(graphOf({}), "b")).toEqual([])
  })
})

describe("imageValues", () => {
  it("is the feature's values the picture sits under", () => {
    const snapshot = boardOf()
    const [location] = boardFeatures(snapshot, "b")
    expect(imageValues(snapshot, location, "blk_pic1000000")).toEqual([
      { id: "blk_mauritius0", text: "Mauritius" },
    ])
    expect(imageValues(snapshot, location, "blk_pic2000000")).toEqual([])
  })
})

describe("addImageOps / imageUploadedOps", () => {
  it("writes an empty image block in the note with no parent — the basket's — then its asset", () => {
    const snapshot = boardOf()
    const ops = addImageOps(snapshot, "b", "blk_new0000000")
    expect(ops).toEqual([
      { op: "create", id: "blk_new0000000", type: "image", text: "", props: null, notesId: "b" },
    ])
    const next = applyOps(snapshot, ops, NOW)
    expect(childIdsOf(next, "b")).not.toContain("blk_new0000000")
    expect(unassignedIds(next).has("blk_new0000000")).toBe(true)
    expect(next.nodes.get("blk_new0000000")?.notes_id).toBe("b")
    // First on the board, ahead of the pictures the outline reaches.
    expect(boardImageIds(next, "b")).toEqual(["blk_new0000000", "blk_pic1000000", "blk_pic2000000"])
    expect(addImageOps(snapshot, "nope", "blk_new0000001")).toEqual([])

    const landed = applyOps(
      next,
      imageUploadedOps("blk_new0000000", { id: "img_abcdefabcdef", width: 40, height: 30 }),
      NOW,
    )
    expect(landed.nodes.get("blk_new0000000")?.props).toBe(
      JSON.stringify({ image: "img_abcdefabcdef", width: 40, height: 30 }),
    )
  })
})

describe("setCaptionOps", () => {
  it("sets the block's text, and does nothing for the same text", () => {
    const snapshot = boardOf()
    expect(setCaptionOps(snapshot, "blk_pic2000000", "A lamp")).toEqual([
      { op: "setText", id: "blk_pic2000000", text: "A lamp" },
    ])
    expect(setCaptionOps(snapshot, "blk_pic2000000", "")).toEqual([])
    expect(setCaptionOps(snapshot, "blk_missing000", "x")).toEqual([])
  })
})

describe("setValueOps", () => {
  it("creates the feature and the value the first time, at the top of the page", () => {
    const snapshot = boardOf()
    const ops = setValueOps(snapshot, "b", FIXTURE, "blk_pic2000000", { text: " Lamp " })
    expect(kinds(ops)).toEqual(["create", "link", "create", "link", "link"])
    const next = applyOps(snapshot, ops, NOW)
    const [fixture] = boardFeatures(next, "b").filter((s) => s.feature === FIXTURE)
    expect(fixture.blockId).not.toBeNull()
    expect(fixture.values.map((v) => v.text)).toEqual(["Lamp"])
    expect(imageValues(next, fixture, "blk_pic2000000")).toEqual(fixture.values)
    // Features together at the top, the pictures where they were.
    expect(childIdsOf(next, "b")).toEqual([
      "blk_location00",
      fixture.blockId,
      "blk_pic1000000",
      "blk_pic2000000",
    ])
    expect(next.nodes.get(fixture.blockId as string)?.notes_id).toBe("b")
  })

  it("reuses an existing value by text, whatever its case", () => {
    const snapshot = boardOf()
    const ops = setValueOps(snapshot, "b", LOCATION, "blk_pic2000000", { text: "lisbon" })
    expect(ops).toEqual([
      expect.objectContaining({
        op: "link",
        source: "blk_lisbon0000",
        destination: "blk_pic2000000",
      }),
    ])
  })

  it("a single-select feature takes the old value back first", () => {
    const snapshot = boardOf()
    const ops = setValueOps(snapshot, "b", LOCATION, "blk_pic1000000", { id: "blk_lisbon0000" })
    expect(ops).toEqual([
      { op: "unlink", source: "blk_mauritius0", destination: "blk_pic1000000" },
      expect.objectContaining({
        op: "link",
        source: "blk_lisbon0000",
        destination: "blk_pic1000000",
      }),
    ])
    const next = applyOps(snapshot, ops, NOW)
    expect(parentIdsOf(next, "blk_pic1000000").sort()).toEqual(["b", "blk_lisbon0000"])
    // The picture is still on the board.
    expect(boardImageIds(next, "b")).toContain("blk_pic1000000")
  })

  it("a multi-select feature keeps the values already carried", () => {
    let snapshot = boardOf()
    snapshot = applyOps(
      snapshot,
      setValueOps(snapshot, "b", FIXTURE, "blk_pic1000000", { text: "Lamp" }),
      NOW,
    )
    snapshot = applyOps(
      snapshot,
      setValueOps(snapshot, "b", FIXTURE, "blk_pic1000000", { text: "Decking" }),
      NOW,
    )
    const [fixture] = boardFeatures(snapshot, "b").filter((s) => s.feature === FIXTURE)
    expect(fixture.values.map((v) => v.text)).toEqual(["Lamp", "Decking"])
    expect(imageValues(snapshot, fixture, "blk_pic1000000").map((v) => v.text)).toEqual([
      "Lamp",
      "Decking",
    ])
  })

  it("is nothing when the picture already carries the value, or the ref names nothing", () => {
    const snapshot = boardOf()
    expect(
      setValueOps(snapshot, "b", LOCATION, "blk_pic1000000", { id: "blk_mauritius0" }),
    ).toEqual([])
    expect(setValueOps(snapshot, "b", LOCATION, "blk_pic1000000", { text: "  " })).toEqual([])
    expect(
      setValueOps(snapshot, "b", LOCATION, "blk_pic1000000", { id: "blk_nope000000" }),
    ).toEqual([])
    expect(setValueOps(snapshot, "nope", LOCATION, "blk_pic1000000", { text: "x" })).toEqual([])
    // A note without the property is not a board, whatever it holds.
    const plain = applyOps(
      snapshot,
      [{ op: "create", id: "p", type: "note", text: "p", props: null }],
      NOW,
    )
    expect(setValueOps(plain, "p", LOCATION, "blk_pic1000000", { text: "x" })).toEqual([])
    expect(addImageOps(plain, "p", "blk_new0000009")).toEqual([])
    expect(setValueOps(snapshot, "b", LOCATION, "blk_nope000000", { text: "x" })).toEqual([])
  })

  it("picks up a board written by hand in the outline", () => {
    const snapshot = graphOf({
      b: [
        "fixture",
        "  id:: blk_fixture000",
        "  - Lamp",
        "    id:: blk_lamp000000",
        img(5),
        "  id:: blk_pic5000000",
        "",
      ].join("\n"),
    })
    const ops = setValueOps(snapshot, "b", FIXTURE, "blk_pic5000000", { text: "Lamp" })
    expect(ops).toEqual([
      expect.objectContaining({
        op: "link",
        source: "blk_lamp000000",
        destination: "blk_pic5000000",
      }),
    ])
  })
})

describe("carryingAll", () => {
  it("keeps the pictures whose parents include every value", () => {
    let snapshot = boardOf()
    snapshot = applyOps(
      snapshot,
      setValueOps(snapshot, "b", FIXTURE, "blk_pic1000000", { text: "Lamp" }),
      NOW,
    )
    const [, fixture] = boardFeatures(snapshot, "b")
    const lamp = fixture.values[0].id
    const all = boardImageIds(snapshot, "b")
    expect(carryingAll(snapshot, all, [])).toEqual(all)
    expect(carryingAll(snapshot, all, ["blk_mauritius0"])).toEqual(["blk_pic1000000"])
    expect(carryingAll(snapshot, all, ["blk_mauritius0", lamp])).toEqual(["blk_pic1000000"])
    expect(carryingAll(snapshot, all, ["blk_lisbon0000", lamp])).toEqual([])
  })
})

describe("a picture's home is the basket until a value takes it", () => {
  it("leaves the basket on its first value and returns on its last clear", () => {
    let snapshot = applyOps(boardOf(), addImageOps(boardOf(), "b", "blk_new0000000"), NOW)
    expect(unassignedIds(snapshot).has("blk_new0000000")).toBe(true)
    snapshot = applyOps(
      snapshot,
      setValueOps(snapshot, "b", LOCATION, "blk_new0000000", { id: "blk_lisbon0000" }),
      NOW + 1,
    )
    expect(unassignedIds(snapshot).has("blk_new0000000")).toBe(false)
    expect(parentIdsOf(snapshot, "blk_new0000000")).toEqual(["blk_lisbon0000"])
    // Still on the board, now among the reached pictures, in document order
    // (Mauritius and its picture come before Lisbon).
    expect(boardImageIds(snapshot, "b")).toEqual([
      "blk_pic1000000",
      "blk_new0000000",
      "blk_pic2000000",
    ])
    snapshot = applyOps(
      snapshot,
      clearValueOps(snapshot, "blk_lisbon0000", "blk_new0000000"),
      NOW + 2,
    )
    expect(unassignedIds(snapshot).has("blk_new0000000")).toBe(true)
    expect(boardImageIds(snapshot, "b")).toContain("blk_new0000000")
  })

  it("lists the basket's pictures most recently changed first", () => {
    let snapshot = boardOf()
    snapshot = applyOps(snapshot, addImageOps(snapshot, "b", "blk_older00000"), NOW)
    snapshot = applyOps(snapshot, addImageOps(snapshot, "b", "blk_newer00000"), NOW + 5)
    expect(unassignedImageIds(snapshot, "b")).toEqual(["blk_newer00000", "blk_older00000"])
  })
})

describe("clearValueOps", () => {
  it("unlinks the value from the picture and leaves the value", () => {
    const snapshot = boardOf()
    const ops = clearValueOps(snapshot, "blk_mauritius0", "blk_pic1000000")
    expect(ops).toEqual([{ op: "unlink", source: "blk_mauritius0", destination: "blk_pic1000000" }])
    const next = applyOps(snapshot, ops, NOW)
    expect(next.nodes.has("blk_mauritius0")).toBe(true)
    expect(boardImageIds(next, "b")).toEqual(["blk_pic1000000", "blk_pic2000000"])
    expect(clearValueOps(next, "blk_mauritius0", "blk_pic1000000")).toEqual([])
  })
})

describe("inverseOps", () => {
  const roundTrip = (snapshot: GraphSnapshot, ops: Op[]) => {
    const after = applyOps(snapshot, ops, NOW)
    const inverse = inverseOps(ops, snapshot)
    expect(inverse).not.toBeNull()
    return applyOps(after, inverse as Op[], NOW + 1)
  }

  it("puts back a first value set: the feature, the value and the link go", () => {
    const snapshot = boardOf()
    const ops = setValueOps(snapshot, "b", FIXTURE, "blk_pic2000000", { text: "Lamp" })
    const back = roundTrip(snapshot, ops)
    expect(walk(back, "b")).toBe(walk(snapshot, "b"))
    expect(back.nodes.size).toBe(snapshot.nodes.size)
  })

  it("puts back a single-select swap at the keys the links had", () => {
    const snapshot = boardOf()
    const ops = setValueOps(snapshot, "b", LOCATION, "blk_pic1000000", { id: "blk_lisbon0000" })
    const back = roundTrip(snapshot, ops)
    expect(walk(back, "b")).toBe(walk(snapshot, "b"))
  })

  it("puts back a caption", () => {
    const snapshot = boardOf()
    const back = roundTrip(snapshot, setCaptionOps(snapshot, "blk_pic2000000", "Lamp"))
    expect(back.nodes.get("blk_pic2000000")?.text).toBe("")
  })

  it("refuses a batch with a delete in it", () => {
    const snapshot = boardOf()
    expect(inverseOps([{ op: "delete", id: "blk_pic2000000" }], snapshot)).toBeNull()
  })
})
