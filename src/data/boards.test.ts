import { describe, expect, it } from "vitest"
import { parse } from "../blocks/parse"
import { serialize } from "../blocks/serialize"
import {
  BOARD_FEATURES,
  addImageOps,
  boardFeatures,
  boardImageIds,
  boardLinkUrl,
  clearValueOps,
  featureBlockId,
  imageLocationOf,
  imageLocationOps,
  imageUploadedOps,
  imageValues,
  inverseOps,
  linkPreviewOps,
  resetImageOps,
  setCaptionOps,
  setValueOps,
  suggestionOps,
  tagFeaturesOf,
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
    // On the board, after the pictures the outline reaches.
    expect(boardImageIds(next, "b")).toEqual(["blk_pic1000000", "blk_pic2000000", "blk_new0000000"])
    expect(addImageOps(snapshot, "nope", "blk_new0000001")).toEqual([])

    const landed = applyOps(
      next,
      imageUploadedOps("blk_new0000000", {
        id: "img_abcdefabcdef",
        width: 40,
        height: 30,
        thumbhash: "YyUKNJh2d3eAiHh3iIeGcGgHdw==",
      }),
      NOW,
    )
    expect(landed.nodes.get("blk_new0000000")?.props).toBe(
      JSON.stringify({
        image: "img_abcdefabcdef",
        width: 40,
        height: 30,
        thumbhash: "YyUKNJh2d3eAiHh3iIeGcGgHdw==",
      }),
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
        "object",
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

describe("tagFeaturesOf", () => {
  it("names every name feature, with the values in use", () => {
    const meaningOf = (label: string) => {
      const feature = BOARD_FEATURES.find((each) => each.label === label)
      return feature?.kind === "text" ? feature.meaning : undefined
    }
    expect(tagFeaturesOf(boardOf(), "b")).toEqual([
      {
        label: "Location",
        multi: false,
        meaning: meaningOf("Location"),
        values: ["Mauritius", "Lisbon"],
      },
      { label: "Object", multi: true, meaning: meaningOf("Object"), values: [] },
      { label: "Material", multi: true, meaning: meaningOf("Material"), values: [] },
    ])
    expect(meaningOf("Object")).toContain("the thing the picture is of")
  })
})

describe("suggestionOps", () => {
  const suggestion = {
    caption: "A rattan lamp",
    features: [
      { label: "Location", values: ["lisbon"] },
      { label: "Object", values: ["Lamp", "Pendant"] },
      { label: "Material", values: [] },
    ],
  }

  it("captions and tags an untagged picture in one batch, creating what is missing", () => {
    const snapshot = boardOf()
    const ops = suggestionOps(snapshot, "b", "blk_pic2000000", suggestion, NOW)
    const next = applyOps(snapshot, ops, NOW)
    expect(next.nodes.get("blk_pic2000000")?.text).toBe("A rattan lamp")
    const [location, fixture] = boardFeatures(next, "b")
    // The existing value by text, whatever its case; the new ones made once.
    expect(imageValues(next, location, "blk_pic2000000")).toEqual([
      { id: "blk_lisbon0000", text: "Lisbon" },
    ])
    expect(fixture.values.map((v) => v.text)).toEqual(["Lamp", "Pendant"])
    expect(imageValues(next, fixture, "blk_pic2000000").map((v) => v.text)).toEqual([
      "Lamp",
      "Pendant",
    ])
    // One Object block, not one per value.
    expect(
      childIdsOf(next, "b").filter((id) => next.nodes.get(id)?.text === "Object"),
    ).toHaveLength(1)
    // And undone as one.
    const undone = applyOps(next, inverseOps(ops, snapshot) as Op[], NOW)
    expect(walk(undone, "b")).toBe(walk(snapshot, "b"))
  })

  it("fills in, and never overrides what the picture already has", () => {
    let snapshot = boardOf()
    snapshot = applyOps(snapshot, setCaptionOps(snapshot, "blk_pic1000000", "Mine"), NOW)
    snapshot = applyOps(
      snapshot,
      setValueOps(snapshot, "b", FIXTURE, "blk_pic1000000", { text: "Lamp" }),
      NOW,
    )
    // The picture has a caption, is in Mauritius, and carries Lamp.
    const ops = suggestionOps(snapshot, "b", "blk_pic1000000", suggestion, NOW)
    // Only the one value it did not have.
    expect(kinds(ops)).toEqual(["create", "link", "link"])
    const next = applyOps(snapshot, ops, NOW)
    expect(next.nodes.get("blk_pic1000000")?.text).toBe("Mine")
    const [location, fixture] = boardFeatures(next, "b")
    expect(imageValues(next, location, "blk_pic1000000").map((v) => v.text)).toEqual(["Mauritius"])
    expect(imageValues(next, fixture, "blk_pic1000000").map((v) => v.text)).toEqual([
      "Lamp",
      "Pendant",
    ])
  })

  it("is nothing for a suggestion with nothing to add, a missing picture, or no board", () => {
    const snapshot = boardOf()
    const empty = { caption: "", features: [{ label: "Location", values: [] }] }
    expect(suggestionOps(snapshot, "b", "blk_pic2000000", empty, NOW)).toEqual([])
    expect(suggestionOps(snapshot, "b", "blk_missing000", suggestion, NOW)).toEqual([])
    expect(suggestionOps(snapshot, "nope", "blk_pic2000000", suggestion, NOW)).toEqual([])
  })

  it("links the board's own value when the text matches one in use, whatever its case", () => {
    const snapshot = boardOf()
    const ops = suggestionOps(
      snapshot,
      "b",
      "blk_pic2000000",
      { caption: "", features: [{ label: "Location", values: ["LISBON"] }] },
      NOW,
    )
    expect(ops).toEqual([
      expect.objectContaining({
        op: "link",
        source: "blk_lisbon0000",
        destination: "blk_pic2000000",
      }),
    ])
    const [location] = boardFeatures(applyOps(snapshot, ops, NOW), "b")
    expect(location.values.map((v) => v.text)).toEqual(["Mauritius", "Lisbon"])
  })
})

describe("resetImageOps", () => {
  it("clears the caption and takes every value off the picture, all features at once", () => {
    let snapshot = boardOf()
    snapshot = applyOps(snapshot, setCaptionOps(snapshot, "blk_pic1000000", "Mine"), NOW)
    snapshot = applyOps(
      snapshot,
      setValueOps(snapshot, "b", FIXTURE, "blk_pic1000000", { text: "Lamp" }),
      NOW,
    )
    // In Mauritius, with a lamp.
    const ops = resetImageOps(snapshot, "b", "blk_pic1000000")
    expect(kinds(ops)).toEqual(["setText", "unlink", "unlink"])
    const next = applyOps(snapshot, ops, NOW)
    const [location, fixture] = boardFeatures(next, "b")
    expect(imageValues(next, location, "blk_pic1000000")).toEqual([])
    expect(imageValues(next, fixture, "blk_pic1000000")).toEqual([])
    expect(next.nodes.get("blk_pic1000000")?.text).toBe("")
    // The values stay for the others; the picture is still on the board.
    expect(fixture.values.map((v) => v.text)).toEqual(["Lamp"])
    expect(boardImageIds(next, "b")).toContain("blk_pic1000000")
    // And undone as one.
    const undone = applyOps(next, inverseOps(ops, snapshot) as Op[], NOW)
    expect(imageValues(undone, boardFeatures(undone, "b")[1], "blk_pic1000000")).toEqual(
      fixture.values,
    )
    expect(undone.nodes.get("blk_pic1000000")?.text).toBe("Mine")
  })

  it("is nothing for a picture with no caption that carries no value, or no board", () => {
    const snapshot = boardOf()
    expect(resetImageOps(snapshot, "b", "blk_pic2000000")).toEqual([])
    expect(resetImageOps(snapshot, "nope", "blk_pic1000000")).toEqual([])
  })
})

describe("where a picture was taken", () => {
  const AT = { lat: 46.05127, lon: 14.50556 }

  it("goes on the block with the asset when known by then, and not otherwise", () => {
    const snapshot = applyOps(boardOf(), addImageOps(boardOf(), "b", "blk_new0000000"), NOW)
    const placed = applyOps(
      snapshot,
      imageUploadedOps("blk_new0000000", { id: "img_abcdefabcdef", width: 40, height: 30 }, AT),
      NOW,
    )
    expect(JSON.parse(placed.nodes.get("blk_new0000000")?.props ?? "null")).toEqual({
      image: "img_abcdefabcdef",
      width: 40,
      height: 30,
      lat: 46.05127,
      lon: 14.50556,
    })
    expect(imageLocationOf(placed, "blk_new0000000")).toEqual(AT)
    const unplaced = applyOps(
      snapshot,
      imageUploadedOps("blk_new0000000", { id: "img_abcdefabcdef" }, null),
      NOW,
    )
    expect(JSON.parse(unplaced.nodes.get("blk_new0000000")?.props ?? "null")).toEqual({
      image: "img_abcdefabcdef",
    })
    expect(imageLocationOf(unplaced, "blk_new0000000")).toBeNull()
  })

  it("is added afterwards to the props the block has, and not to a block that is gone", () => {
    let snapshot = applyOps(boardOf(), addImageOps(boardOf(), "b", "blk_new0000000"), NOW)
    snapshot = applyOps(
      snapshot,
      imageUploadedOps("blk_new0000000", { id: "img_abcdefabcdef", width: 40, height: 30 }),
      NOW,
    )
    const ops = imageLocationOps(snapshot, "blk_new0000000", AT)
    expect(kinds(ops)).toEqual(["setProps"])
    const placed = applyOps(snapshot, ops, NOW)
    expect(JSON.parse(placed.nodes.get("blk_new0000000")?.props ?? "null")).toEqual({
      image: "img_abcdefabcdef",
      width: 40,
      height: 30,
      lat: 46.05127,
      lon: 14.50556,
    })
    expect(imageLocationOps(snapshot, "blk_missing000", AT)).toEqual([])
    const gone = applyOps(snapshot, [{ op: "delete", id: "blk_new0000000" }], NOW)
    expect(imageLocationOps(gone, "blk_new0000000", AT)).toEqual([])
  })

  it("reads nothing off a block whose coordinates are not numbers", () => {
    const snapshot = applyOps(
      boardOf(),
      [
        {
          op: "setProps",
          id: "blk_pic1000000",
          props: JSON.stringify({ image: "img_x", lat: "46", lon: 14 }),
        },
      ],
      NOW,
    )
    expect(imageLocationOf(snapshot, "blk_pic1000000")).toBeNull()
    expect(imageLocationOf(snapshot, "blk_pic2000000")).toBeNull()
  })
})

describe("a link feature", () => {
  const LINK = BOARD_FEATURES[3]
  const url = "https://www.made.com/lamp"
  /** A board whose first picture has been given the address: the card made,
   * and its id. */
  const withCard = () => {
    const snapshot = boardOf()
    const next = applyOps(
      snapshot,
      setValueOps(snapshot, "b", LINK, "blk_pic1000000", { url }),
      NOW,
    )
    return { snapshot: next, card: boardFeatures(next, "b")[3].values[0].id }
  }

  it("is the last of the preset, takes several values, and its values are addresses", () => {
    expect(LINK).toEqual({ label: "Link", multi: true, kind: "link" })
  })

  it("takes an address with or without its scheme, and nothing that is not one", () => {
    expect(boardLinkUrl(" made.com/lamp ")).toBe("https://made.com/lamp")
    expect(boardLinkUrl("http://made.com")).toBe("http://made.com")
    expect(boardLinkUrl("a lamp")).toBeNull()
    expect(boardLinkUrl("")).toBeNull()
  })

  it("makes the Link block and a card titled by the host, and links the picture under it", () => {
    const snapshot = boardOf()
    const ops = setValueOps(snapshot, "b", LINK, "blk_pic2000000", { url: "www.made.com/lamp" })
    expect(kinds(ops)).toEqual(["create", "link", "create", "link", "link"])
    const next = applyOps(snapshot, ops, NOW)
    const link = boardFeatures(next, "b")[3]
    expect(link.values).toEqual([{ id: expect.any(String), text: "made.com", link: { url } }])
    const card = link.values[0].id
    expect(next.nodes.get(card)?.type).toBe("link")
    expect(imageValues(next, link, "blk_pic2000000")).toEqual(link.values)
    expect(parentIdsOf(next, "blk_pic2000000")).toContain(card)
    // In the outline: the card beneath the Link block, the picture beneath
    // the card, as markdown writes a link block.
    expect(walk(next, "b")).toContain("[made.com](https://www.made.com/lamp)")
    expect(childIdsOf(next, card)).toEqual(["blk_pic2000000"])
  })

  it("reuses the board's card for the same address, a trailing slash aside", () => {
    const { snapshot, card } = withCard()
    const ops = setValueOps(snapshot, "b", LINK, "blk_pic2000000", { url: `${url}/` })
    expect(ops).toEqual([
      expect.objectContaining({ op: "link", source: card, destination: "blk_pic2000000" }),
    ])
  })

  it("makes nothing of a name, of an address that is not one, or of an address to a name feature", () => {
    const snapshot = boardOf()
    expect(setValueOps(snapshot, "b", LINK, "blk_pic2000000", { text: "made.com" })).toEqual([])
    expect(setValueOps(snapshot, "b", LINK, "blk_pic2000000", { url: "a lamp" })).toEqual([])
    expect(setValueOps(snapshot, "b", LOCATION, "blk_pic2000000", { url })).toEqual([])
  })

  it("reads only the link blocks under a Link block written by hand as values", () => {
    const snapshot = applyOps(
      graphOf({
        b: [
          "Link",
          "  id:: blk_link000000",
          "  - made.com",
          "    id:: blk_typed00000",
          img(1),
          "  id:: blk_pic1000000",
          "",
        ].join("\n"),
      }),
      [
        {
          op: "create",
          id: "blk_card000000",
          type: "link",
          text: "",
          props: JSON.stringify({ url }),
          notesId: "b",
        },
        { op: "link", source: "blk_link000000", destination: "blk_card000000", sortKey: "z" },
      ],
      1,
    )
    const link = boardFeatures(snapshot, "b")[3]
    expect(link.blockId).toBe("blk_link000000")
    expect(link.values).toEqual([{ id: "blk_card000000", text: "", link: { url } }])
    // A picture given that address goes under the card that is there.
    expect(setValueOps(snapshot, "b", LINK, "blk_pic1000000", { url })).toEqual([
      expect.objectContaining({
        op: "link",
        source: "blk_card000000",
        destination: "blk_pic1000000",
      }),
    ])
  })

  it("comes off with the rest on Reset, and a first set is undone whole", () => {
    const { snapshot, card } = withCard()
    // In Mauritius, from made.com.
    const reset = resetImageOps(snapshot, "b", "blk_pic1000000")
    expect(reset).toEqual([
      { op: "unlink", source: "blk_mauritius0", destination: "blk_pic1000000" },
      { op: "unlink", source: card, destination: "blk_pic1000000" },
    ])
    const before = boardOf()
    const ops = setValueOps(before, "b", LINK, "blk_pic2000000", { url })
    const after = applyOps(before, ops, NOW)
    const back = applyOps(after, inverseOps(ops, before) as Op[], NOW + 1)
    expect(walk(back, "b")).toBe(walk(before, "b"))
  })

  describe("linkPreviewOps", () => {
    const preview = {
      url,
      title: "Oak pendant lamp",
      description: "A lamp.",
      site: "MADE",
      favicon: "https://made.com/f.ico",
      image: "https://made.com/p.jpg",
    }

    it("writes the preview on the card and names it by the page's title", () => {
      const { snapshot, card } = withCard()
      const ops = linkPreviewOps(snapshot, card, url, preview)
      expect(kinds(ops)).toEqual(["setProps", "setText"])
      const next = applyOps(snapshot, ops, NOW)
      expect(boardFeatures(next, "b")[3].values).toEqual([
        {
          id: card,
          text: "Oak pendant lamp",
          link: {
            url,
            description: "A lamp.",
            site: "MADE",
            favicon: "https://made.com/f.ico",
            image: "https://made.com/p.jpg",
          },
        },
      ])
    })

    it("keeps a name given since, and writes nothing for a card gone or pointing elsewhere", () => {
      const { snapshot, card } = withCard()
      const named = applyOps(snapshot, [{ op: "setText", id: card, text: "The lamp" }], NOW)
      expect(kinds(linkPreviewOps(named, card, url, preview))).toEqual(["setProps"])
      expect(linkPreviewOps(snapshot, card, "https://other.com/", preview)).toEqual([])
      expect(linkPreviewOps(snapshot, "blk_nope000000", url, preview)).toEqual([])
      const gone = applyOps(snapshot, [{ op: "delete", id: card }], NOW)
      expect(linkPreviewOps(gone, card, url, preview)).toEqual([])
    })
  })

  it("is not told to the model, and nothing the model says of one is applied", () => {
    const snapshot = boardOf()
    expect(tagFeaturesOf(snapshot, "b").map((feature) => feature.label)).toEqual([
      "Location",
      "Object",
      "Material",
    ])
    const suggestion = { caption: "", features: [{ label: "Link", values: ["https://made.com"] }] }
    expect(suggestionOps(snapshot, "b", "blk_pic2000000", suggestion, NOW)).toEqual([])
  })
})
