import { describe, expect, it } from "vitest"
import { moveBlocks, updateText } from "../blocks/ops"
import { parse } from "../blocks/parse"
import { serialize } from "../blocks/serialize"
import { keyOf } from "../blocks/view"
import {
  DEFAULT_FEATURES,
  addFeatureOps,
  addImageOps,
  boardFeature,
  boardFeatures,
  boardImageIds,
  boardLinkUrl,
  clearValueOps,
  defaultFeatureOps,
  featureSpecOf,
  imageLocationOf,
  imageLocationOps,
  imageUploadedOps,
  imageValues,
  inverseOps,
  linkPreviewOps,
  removeFeatureOps,
  resetImageOps,
  setCaptionOps,
  setValueOps,
  suggestionOps,
  tagFeaturesOf,
  unassignedImageIds,
  updateFeatureOps,
} from "./boards"
import {
  buildGraphSnapshot,
  childIdsOf,
  docToGraph,
  noteDoc,
  parentIdsOf,
  parseProps,
  type GraphSnapshot,
} from "./graph"
import { applyOps, docToOps, type Op } from "./ops"
import { unassignedIds } from "./basket"

const NOW = 1000

/** The fixture's features, by their blocks: Location is read by its name
 * alone, as a board from before features were blocks has it; Object
 * carries the prop. */
const LOCATION = "blk_location00"
const OBJECT = "blk_object0000"

const OBJECT_SPEC = { type: "text", multi: true, notes: "the thing the picture is of" }

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

/** The feature prop as a block's props string. */
const featureProps = (spec: Record<string, unknown>) => JSON.stringify({ feature: spec })

/** A board with two pictures and two features on it: Location, with two
 * values, read by its name; Object, empty, with the prop. The first
 * picture is in Mauritius: linked under that value as well as the page
 * (`boardOf` adds the second parent — markdown cannot say it twice, nor
 * write a prop). */
const BOARD = [
  "Location",
  "  id:: blk_location00",
  "  - Mauritius",
  "    id:: blk_mauritius0",
  "  - Lisbon",
  "    id:: blk_lisbon0000",
  "- Object",
  "  id:: blk_object0000",
  img(1),
  "  id:: blk_pic1000000",
  img(2),
  "  id:: blk_pic2000000",
  "",
].join("\n")

const boardOf = (extra = "") =>
  applyOps(
    graphOf({ b: extra + BOARD }),
    [
      { op: "link", source: "blk_mauritius0", destination: "blk_pic1000000", sortKey: "a0" },
      { op: "setProps", id: OBJECT, props: featureProps(OBJECT_SPEC) },
    ],
    1,
  )

/** The feature's state, by its block, asserted to be there. */
const stateOf = (snapshot: GraphSnapshot, featureId: string) => {
  const state = boardFeature(snapshot, "b", featureId)
  if (!state) throw new Error(`no feature ${featureId}`)
  return state
}

describe("featureSpecOf", () => {
  it("reads the prop leniently: a type it does not know is text, multi only when true", () => {
    expect(featureSpecOf({ feature: { type: "place", multi: false, notes: " where " } })).toEqual({
      type: "place",
      multi: false,
      notes: "where",
    })
    expect(featureSpecOf({ feature: {} })).toEqual({ type: "text", multi: false })
    expect(featureSpecOf({ feature: { type: "colour", multi: "yes", notes: "" } })).toEqual({
      type: "text",
      multi: false,
    })
    // The key the notes were first written under is still read.
    expect(featureSpecOf({ feature: { type: "text", multi: true, meaning: "old" } })).toEqual({
      type: "text",
      multi: true,
      notes: "old",
    })
    expect(featureSpecOf({ feature: true })).toBeNull()
    expect(featureSpecOf({ feature: false })).toBeNull()
    expect(featureSpecOf({ feature: [] })).toBeNull()
    expect(featureSpecOf({ align: "left" })).toBeNull()
    expect(featureSpecOf(null)).toBeNull()
  })
})

describe("boardFeatures", () => {
  it("lists the feature blocks in page order, the legacy ones by name, with their values", () => {
    const snapshot = boardOf()
    const state = boardFeatures(snapshot, "b")
    expect(state).toEqual([
      {
        feature: {
          id: LOCATION,
          label: "Location",
          type: "place",
          multi: false,
          notes: DEFAULT_FEATURES[0].spec.notes,
        },
        values: [
          { id: "blk_mauritius0", text: "Mauritius" },
          { id: "blk_lisbon0000", text: "Lisbon" },
        ],
      },
      {
        feature: { id: OBJECT, label: "Object", ...OBJECT_SPEC },
        values: [],
      },
    ])
  })

  it("reads a block with the prop whatever its name, and a child without one as content", () => {
    const snapshot = applyOps(
      graphOf({
        b: [
          "- Notes",
          "  id:: blk_notes00000",
          "  - Location",
          "    id:: blk_deep000000",
          "- Colour",
          "  id:: blk_colour0000",
          "  - Teal",
          "    id:: blk_teal000000",
          "- Shopping list",
          "  id:: blk_list000000",
          "",
        ].join("\n"),
      }),
      [
        {
          op: "setProps",
          id: "blk_colour0000",
          props: featureProps({ type: "text", multi: true }),
        },
      ],
      1,
    )
    const state = boardFeatures(snapshot, "b")
    expect(state.map((s) => s.feature.id)).toEqual(["blk_colour0000"])
    expect(state[0].feature).toEqual({
      id: "blk_colour0000",
      label: "Colour",
      type: "text",
      multi: true,
      notes: "",
    })
    expect(state[0].values.map((v) => v.text)).toEqual(["Teal"])
  })

  it("reads a legacy name trimmed and whatever its case, the first only, never a deeper one", () => {
    const snapshot = graphOf({
      b: [
        "- Notes",
        "  id:: blk_notes00000",
        "  - Location",
        "    id:: blk_deep000000",
        "- location ",
        "  id:: blk_first00000",
        "- Location",
        "  id:: blk_second0000",
        "- Link",
        "  id:: blk_link000000",
        "",
      ].join("\n"),
    })
    const state = boardFeatures(snapshot, "b")
    expect(state.map((s) => [s.feature.id, s.feature.type, s.feature.multi])).toEqual([
      ["blk_first00000", "place", false],
      ["blk_link000000", "link", true],
    ])
    expect(state[1].feature.notes).toBe("")
  })

  it("follows the blocks' order on the page, and a rename keeps the feature", () => {
    const snapshot = boardOf()
    const renamed = applyOps(snapshot, [{ op: "setText", id: OBJECT, text: "Thing" }], NOW)
    expect(boardFeatures(renamed, "b").map((s) => [s.feature.id, s.feature.label])).toEqual([
      [LOCATION, "Location"],
      [OBJECT, "Thing"],
    ])
    const swapped = applyOps(
      renamed,
      [{ op: "link", source: "b", destination: OBJECT, sortKey: "0" }],
      NOW,
    )
    expect(boardFeatures(swapped, "b").map((s) => s.feature.id)).toEqual([OBJECT, LOCATION])
  })

  it("does not read a picture under a feature as a value", () => {
    const snapshot = graphOf({
      b: `Location\n  id:: blk_location00\n  ${img(9)}\n    id:: blk_stray00000\n`,
    })
    expect(boardFeatures(snapshot, "b")[0].values).toEqual([])
  })

  it("is empty for a note with no features, and finds one feature by its block", () => {
    expect(boardFeatures(graphOf({ b: `${img(1)}\n` }), "b")).toEqual([])
    expect(boardFeature(boardOf(), "b", OBJECT)?.feature.label).toBe("Object")
    expect(boardFeature(boardOf(), "b", "blk_pic1000000")).toBeNull()
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
  it("creates the value under the feature the first time, and links the picture beneath it", () => {
    const snapshot = boardOf()
    const ops = setValueOps(snapshot, "b", OBJECT, "blk_pic2000000", { text: " Lamp " })
    expect(kinds(ops)).toEqual(["create", "link", "link"])
    const next = applyOps(snapshot, ops, NOW)
    const object = stateOf(next, OBJECT)
    expect(object.values.map((v) => v.text)).toEqual(["Lamp"])
    expect(imageValues(next, object, "blk_pic2000000")).toEqual(object.values)
    expect(next.nodes.get(object.values[0].id)?.notes_id).toBe("b")
    expect(next.nodes.get(object.values[0].id)?.type).toBe("ul")
    // The page is as it was: no feature is made here.
    expect(childIdsOf(next, "b")).toEqual(childIdsOf(snapshot, "b"))
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
      setValueOps(snapshot, "b", OBJECT, "blk_pic1000000", { text: "Lamp" }),
      NOW,
    )
    snapshot = applyOps(
      snapshot,
      setValueOps(snapshot, "b", OBJECT, "blk_pic1000000", { text: "Decking" }),
      NOW,
    )
    const object = stateOf(snapshot, OBJECT)
    expect(object.values.map((v) => v.text)).toEqual(["Lamp", "Decking"])
    expect(imageValues(snapshot, object, "blk_pic1000000").map((v) => v.text)).toEqual([
      "Lamp",
      "Decking",
    ])
  })

  it("is nothing when the picture already carries the value, or the ref or feature names nothing", () => {
    const snapshot = boardOf()
    expect(
      setValueOps(snapshot, "b", LOCATION, "blk_pic1000000", { id: "blk_mauritius0" }),
    ).toEqual([])
    expect(setValueOps(snapshot, "b", LOCATION, "blk_pic1000000", { text: "  " })).toEqual([])
    expect(
      setValueOps(snapshot, "b", LOCATION, "blk_pic1000000", { id: "blk_nope000000" }),
    ).toEqual([])
    expect(setValueOps(snapshot, "nope", LOCATION, "blk_pic1000000", { text: "x" })).toEqual([])
    // A feature is its block: a block that is not one takes no value.
    expect(setValueOps(snapshot, "b", "blk_nope000000", "blk_pic1000000", { text: "x" })).toEqual(
      [],
    )
    expect(setValueOps(snapshot, "b", "blk_pic1000000", "blk_pic2000000", { text: "x" })).toEqual(
      [],
    )
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
        "  id:: blk_byhand0000",
        "  - Lamp",
        "    id:: blk_lamp000000",
        img(5),
        "  id:: blk_pic5000000",
        "",
      ].join("\n"),
    })
    expect(boardFeatures(snapshot, "b")[0].feature.id).toBe("blk_byhand0000")
    const ops = setValueOps(snapshot, "b", "blk_byhand0000", "blk_pic5000000", { text: "Lamp" })
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

  it("puts back a first value set: the value and the link go", () => {
    const snapshot = boardOf()
    const ops = setValueOps(snapshot, "b", OBJECT, "blk_pic2000000", { text: "Lamp" })
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
  it("names every text and place feature, with its notes and the values in use", () => {
    expect(tagFeaturesOf(boardOf(), "b")).toEqual([
      {
        label: "Location",
        multi: false,
        notes: DEFAULT_FEATURES[0].spec.notes,
        values: ["Mauritius", "Lisbon"],
        place: true,
      },
      { label: "Object", multi: true, notes: "the thing the picture is of", values: [] },
    ])
    expect(DEFAULT_FEATURES[1].spec.notes).toContain("the thing the picture is of")
  })

  it("leaves out a link feature, and the notes of a feature with none", () => {
    let snapshot = boardOf()
    snapshot = applyOps(snapshot, addFeatureOps(snapshot, "b", "blk_added00000"), NOW)
    snapshot = applyOps(
      snapshot,
      [
        { op: "setText", id: "blk_added00000", text: "Source" },
        {
          op: "setProps",
          id: "blk_added00000",
          props: featureProps({ type: "link", multi: true }),
        },
      ],
      NOW,
    )
    snapshot = applyOps(snapshot, addFeatureOps(snapshot, "b", "blk_colour0000"), NOW)
    expect(tagFeaturesOf(snapshot, "b").map((feature) => feature.label)).toEqual([
      "Location",
      "Object",
      "New feature",
    ])
    expect(tagFeaturesOf(snapshot, "b")[2]).toEqual({
      label: "New feature",
      multi: true,
      values: [],
    })
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

  it("captions and tags an untagged picture in one batch, creating the values it lacks", () => {
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
    // Material names no feature on this board, so nothing is made for it.
    expect(childIdsOf(next, "b")).toEqual(childIdsOf(snapshot, "b"))
    // And undone as one.
    const undone = applyOps(next, inverseOps(ops, snapshot) as Op[], NOW)
    expect(walk(undone, "b")).toBe(walk(snapshot, "b"))
  })

  it("fills in, and never overrides what the picture already has", () => {
    let snapshot = boardOf()
    snapshot = applyOps(snapshot, setCaptionOps(snapshot, "blk_pic1000000", "Mine"), NOW)
    snapshot = applyOps(
      snapshot,
      setValueOps(snapshot, "b", OBJECT, "blk_pic1000000", { text: "Lamp" }),
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

  it("reads the answer by the feature's label, as the board names it now", () => {
    const snapshot = applyOps(boardOf(), [{ op: "setText", id: OBJECT, text: "Thing" }], NOW)
    const answer = { caption: "", features: [{ label: "thing", values: ["Lamp"] }] }
    const ops = suggestionOps(snapshot, "b", "blk_pic2000000", answer, NOW)
    expect(kinds(ops)).toEqual(["create", "link", "link"])
    const asked = { caption: "", features: [{ label: "Object", values: ["Lamp"] }] }
    expect(suggestionOps(snapshot, "b", "blk_pic2000000", asked, NOW)).toEqual([])
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
      setValueOps(snapshot, "b", OBJECT, "blk_pic1000000", { text: "Lamp" }),
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
  const LINK = "blk_source0000"
  const url = "https://www.made.com/lamp"
  /** The fixture with a link feature, Source, after the others. */
  const withLink = () =>
    applyOps(
      boardOf(),
      [
        {
          op: "create",
          id: LINK,
          type: "ul",
          text: "Source",
          props: featureProps({ type: "link", multi: true }),
          notesId: "b",
        },
        { op: "link", source: "b", destination: LINK, sortKey: "a5" },
      ],
      1,
    )
  /** A board whose first picture has been given the address: the card made,
   * and its id. */
  const withCard = () => {
    const snapshot = withLink()
    const next = applyOps(
      snapshot,
      setValueOps(snapshot, "b", LINK, "blk_pic1000000", { url }),
      NOW,
    )
    return { snapshot: next, card: stateOf(next, LINK).values[0].id }
  }

  it("takes an address with or without its scheme, and nothing that is not one", () => {
    expect(boardLinkUrl(" made.com/lamp ")).toBe("https://made.com/lamp")
    expect(boardLinkUrl("http://made.com")).toBe("http://made.com")
    expect(boardLinkUrl("a lamp")).toBeNull()
    expect(boardLinkUrl("")).toBeNull()
  })

  it("makes a card titled by the host, and links the picture under it", () => {
    const snapshot = withLink()
    const ops = setValueOps(snapshot, "b", LINK, "blk_pic2000000", { url: "www.made.com/lamp" })
    expect(kinds(ops)).toEqual(["create", "link", "link"])
    const next = applyOps(snapshot, ops, NOW)
    const link = stateOf(next, LINK)
    expect(link.values).toEqual([{ id: expect.any(String), text: "made.com", link: { url } }])
    const card = link.values[0].id
    expect(next.nodes.get(card)?.type).toBe("link")
    expect(imageValues(next, link, "blk_pic2000000")).toEqual(link.values)
    expect(parentIdsOf(next, "blk_pic2000000")).toContain(card)
    // In the outline: the card beneath the feature block, the picture
    // beneath the card, as markdown writes a link block.
    expect(walk(next, "b")).toContain("[made.com](https://www.made.com/lamp)")
    expect(childIdsOf(next, card)).toEqual(["blk_pic2000000"])
  })

  it("names the card by the title given, and shows a card with no title by its host", () => {
    const snapshot = withLink()
    const ops = setValueOps(snapshot, "b", LINK, "blk_pic2000000", {
      url,
      title: " Oak lamp ",
    })
    const next = applyOps(snapshot, ops, NOW)
    expect(stateOf(next, LINK).values.map((v) => v.text)).toEqual(["Oak lamp"])
    const untitled = applyOps(
      next,
      [{ op: "setText", id: stateOf(next, LINK).values[0].id, text: "" }],
      NOW,
    )
    expect(stateOf(untitled, LINK).values.map((v) => v.text)).toEqual(["made.com"])
  })

  it("reuses the board's card for the same address, a trailing slash aside", () => {
    const { snapshot, card } = withCard()
    const ops = setValueOps(snapshot, "b", LINK, "blk_pic2000000", { url: `${url}/` })
    expect(ops).toEqual([
      expect.objectContaining({ op: "link", source: card, destination: "blk_pic2000000" }),
    ])
  })

  it("makes nothing of a name, of an address that is not one, or of an address to a name feature", () => {
    const snapshot = withLink()
    expect(setValueOps(snapshot, "b", LINK, "blk_pic2000000", { text: "made.com" })).toEqual([])
    expect(setValueOps(snapshot, "b", LINK, "blk_pic2000000", { url: "a lamp" })).toEqual([])
    expect(setValueOps(snapshot, "b", LOCATION, "blk_pic2000000", { url })).toEqual([])
  })

  it("reads only the link blocks under a legacy Link block written by hand as values", () => {
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
    const link = stateOf(snapshot, "blk_link000000")
    expect(link.feature.type).toBe("link")
    expect(link.values).toEqual([{ id: "blk_card000000", text: "made.com", link: { url } }])
    // A picture given that address goes under the card that is there.
    expect(setValueOps(snapshot, "b", "blk_link000000", "blk_pic1000000", { url })).toEqual([
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
    const before = withLink()
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
      expect(stateOf(next, LINK).values).toEqual([
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
    const snapshot = withLink()
    expect(tagFeaturesOf(snapshot, "b").map((feature) => feature.label)).toEqual([
      "Location",
      "Object",
    ])
    const suggestion = {
      caption: "",
      features: [{ label: "Source", values: ["https://made.com"] }],
    }
    expect(suggestionOps(snapshot, "b", "blk_pic2000000", suggestion, NOW)).toEqual([])
  })
})

describe("the defaults", () => {
  it("are written onto a new board as blocks with the prop, in order, after any feature there", () => {
    const empty = graphOf({ b: `${img(1)}\n  id:: blk_pic1000000\n` })
    const ops = defaultFeatureOps(empty, "b")
    expect(kinds(ops)).toEqual([
      "create",
      "link",
      "create",
      "link",
      "create",
      "link",
      "create",
      "link",
    ])
    const next = applyOps(empty, ops, NOW)
    const features = boardFeatures(next, "b")
    expect(features.map((s) => [s.feature.label, s.feature.type, s.feature.multi])).toEqual([
      ["Location", "place", false],
      ["Object", "text", true],
      ["Material", "text", true],
      ["Link", "link", true],
    ])
    expect(features.map((s) => s.feature.notes)).toEqual(
      DEFAULT_FEATURES.map((entry) => entry.spec.notes ?? ""),
    )
    // Each a bullet carrying the prop, before the picture.
    for (const { feature } of features) {
      const node = next.nodes.get(feature.id)
      expect(node?.type).toBe("ul")
      expect(node?.notes_id).toBe("b")
      expect(featureSpecOf(parseProps(node?.props ?? null))).toEqual(
        DEFAULT_FEATURES.find((entry) => entry.label === feature.label)?.spec,
      )
    }
    expect(childIdsOf(next, "b").map((id) => next.nodes.get(id)?.text)).toEqual([
      "Location",
      "Object",
      "Material",
      "Link",
      "",
    ])
    expect(childIdsOf(next, "b").at(-1)).toBe("blk_pic1000000")
  })

  it("leave a default the board already has by label, and are nothing for a plain note", () => {
    const snapshot = boardOf()
    const ops = defaultFeatureOps(snapshot, "b")
    expect(kinds(ops)).toEqual(["create", "link", "create", "link"])
    const next = applyOps(snapshot, ops, NOW)
    expect(boardFeatures(next, "b").map((s) => s.feature.label)).toEqual([
      "Location",
      "Object",
      "Material",
      "Link",
    ])
    // Together at the top, the pictures where they were.
    expect(childIdsOf(next, "b").slice(-2)).toEqual(["blk_pic1000000", "blk_pic2000000"])
    const plain = graphOf({ b: "" })
    const unmade = applyOps(plain, [{ op: "setProps", id: "b", props: null }], NOW)
    expect(defaultFeatureOps(unmade, "b")).toEqual([])
  })
})

describe("the Features editor", () => {
  it("adds a text feature named New feature after the others, with the prop", () => {
    const snapshot = boardOf()
    const ops = addFeatureOps(snapshot, "b", "blk_added00000")
    expect(kinds(ops)).toEqual(["create", "link"])
    const next = applyOps(snapshot, ops, NOW)
    expect(boardFeatures(next, "b").map((s) => s.feature.id)).toEqual([
      LOCATION,
      OBJECT,
      "blk_added00000",
    ])
    expect(stateOf(next, "blk_added00000").feature).toEqual({
      id: "blk_added00000",
      label: "New feature",
      type: "text",
      multi: true,
      notes: "",
    })
    expect(childIdsOf(next, "b")).toEqual([
      LOCATION,
      OBJECT,
      "blk_added00000",
      "blk_pic1000000",
      "blk_pic2000000",
    ])
    expect(addFeatureOps(next, "b", "blk_added00000")).toEqual([])
    expect(addFeatureOps(snapshot, "nope", "blk_other00000")).toEqual([])
  })

  it("renames by the block's text, and the rest by the prop, stamping a legacy feature", () => {
    const snapshot = boardOf()
    const ops = updateFeatureOps(snapshot, "b", LOCATION, { label: " Place ", multi: true })
    expect(ops).toEqual([
      { op: "setText", id: LOCATION, text: "Place" },
      {
        op: "setProps",
        id: LOCATION,
        props: featureProps({
          type: "place",
          multi: true,
          notes: DEFAULT_FEATURES[0].spec.notes,
        }),
      },
    ])
    const next = applyOps(snapshot, ops, NOW)
    // The same feature, its values still its own.
    const place = stateOf(next, LOCATION)
    expect(place.feature.label).toBe("Place")
    expect(place.values.map((v) => v.text)).toEqual(["Mauritius", "Lisbon"])
    expect(imageValues(next, place, "blk_pic1000000").map((v) => v.text)).toEqual(["Mauritius"])
    // A notes cleared is left out of the prop; nothing to change is nothing.
    const cleared = updateFeatureOps(next, "b", LOCATION, { notes: "  " })
    expect(cleared).toEqual([
      { op: "setProps", id: LOCATION, props: featureProps({ type: "place", multi: true }) },
    ])
    expect(updateFeatureOps(next, "b", LOCATION, { label: "Place" })).toEqual([])
    expect(updateFeatureOps(next, "b", LOCATION, { label: "" })).toEqual([])
    expect(updateFeatureOps(next, "b", "blk_pic1000000", { label: "x" })).toEqual([])
  })

  it("keeps the other props of the block, and changes a type between names freely", () => {
    const snapshot = applyOps(
      boardOf(),
      [
        {
          op: "setProps",
          id: OBJECT,
          props: JSON.stringify({ align: "left", feature: OBJECT_SPEC }),
        },
      ],
      NOW,
    )
    const next = applyOps(snapshot, updateFeatureOps(snapshot, "b", OBJECT, { type: "place" }), NOW)
    expect(parseProps(next.nodes.get(OBJECT)?.props ?? null)).toEqual({
      align: "left",
      feature: { ...OBJECT_SPEC, type: "place" },
    })
  })

  it("refuses a change between a name and a link while the feature has values", () => {
    const snapshot = boardOf()
    // Location has values: it stays a place, the rest of the patch goes through.
    expect(updateFeatureOps(snapshot, "b", LOCATION, { type: "link", multi: true })).toEqual([
      {
        op: "setProps",
        id: LOCATION,
        props: featureProps({
          type: "place",
          multi: true,
          notes: DEFAULT_FEATURES[0].spec.notes,
        }),
      },
    ])
    // Object has none: it may become a link.
    const linked = applyOps(
      snapshot,
      updateFeatureOps(snapshot, "b", OBJECT, { type: "link" }),
      NOW,
    )
    expect(stateOf(linked, OBJECT).feature.type).toBe("link")
    const withCard = applyOps(
      linked,
      setValueOps(linked, "b", OBJECT, "blk_pic2000000", { url: "https://made.com" }),
      NOW,
    )
    expect(updateFeatureOps(withCard, "b", OBJECT, { type: "text" })).toEqual([])
  })

  it("removes a feature by taking the prop off its block, deleting nothing, and Undo puts it back", () => {
    const snapshot = boardOf()
    // Object, renamed Thing, carries the prop and another prop beside it.
    const kept = applyOps(
      snapshot,
      [
        { op: "setText", id: OBJECT, text: "Thing" },
        {
          op: "setProps",
          id: OBJECT,
          props: JSON.stringify({ align: "left", feature: OBJECT_SPEC }),
        },
      ],
      NOW,
    )
    const withValue = applyOps(
      kept,
      setValueOps(kept, "b", OBJECT, "blk_pic2000000", { text: "Lamp" }),
      NOW,
    )
    const lamp = stateOf(withValue, OBJECT).values[0].id
    const ops = removeFeatureOps(withValue, "b", OBJECT)
    expect(ops).toEqual([{ op: "setProps", id: OBJECT, props: JSON.stringify({ align: "left" }) }])
    const next = applyOps(withValue, ops, NOW)
    // No longer a feature; the block, its value and the picture's link stay.
    expect(boardFeatures(next, "b").map((s) => s.feature.id)).toEqual([LOCATION])
    expect(childIdsOf(next, "b")).toEqual(childIdsOf(withValue, "b"))
    expect(childIdsOf(next, OBJECT)).toEqual([lamp])
    expect(parentIdsOf(next, "blk_pic2000000")).toContain(lamp)
    expect(next.nodes.get(OBJECT)?.text).toBe("Thing")
    // And back, whole.
    const inverse = inverseOps(ops, withValue)
    expect(inverse).toEqual([
      { op: "setProps", id: OBJECT, props: withValue.nodes.get(OBJECT)?.props },
    ])
    const undone = applyOps(next, inverse as Op[], NOW)
    expect(stateOf(undone, OBJECT).feature).toEqual({ id: OBJECT, label: "Thing", ...OBJECT_SPEC })
    expect(stateOf(undone, OBJECT).values.map((v) => v.id)).toEqual([lamp])
    expect(removeFeatureOps(snapshot, "b", "blk_pic1000000")).toEqual([])
  })

  it("marks a removed feature named as one of old, so its name does not make it one again", () => {
    const snapshot = boardOf()
    const ops = removeFeatureOps(snapshot, "b", LOCATION)
    expect(ops).toEqual([
      { op: "setProps", id: LOCATION, props: JSON.stringify({ feature: false }) },
    ])
    const next = applyOps(snapshot, ops, NOW)
    expect(boardFeatures(next, "b").map((s) => s.feature.id)).toEqual([OBJECT])
    expect(next.nodes.has("blk_mauritius0")).toBe(true)
    expect(parentIdsOf(next, "blk_pic1000000")).toContain("blk_mauritius0")
    // Undo takes the prop off again, and the name reads as the feature it was.
    const undone = applyOps(next, inverseOps(ops, snapshot) as Op[], NOW)
    expect(boardFeatures(undone, "b").map((s) => s.feature.id)).toEqual([LOCATION, OBJECT])
    // The defaults would write Location afresh: the marked block is content now.
    expect(defaultFeatureOps(next, "b").map((op) => op.op)).toEqual([
      "create",
      "link",
      "create",
      "link",
      "create",
      "link",
    ])
  })
})

describe("a feature block in the outline", () => {
  it("keeps its prop through a text edit and a move made in the editor", () => {
    const snapshot = boardOf()
    const doc = noteDoc("b", snapshot)
    if (!doc) throw new Error("no doc")
    // Retitle the Object block as the editor does, and move it to the top.
    const retitled = updateText(doc, OBJECT, "Thing")
    const moved = moveBlocks(retitled, [keyOf(null, OBJECT)], "up")
    const ops = docToOps("b", moved, snapshot)
    expect(kinds(ops).sort()).toEqual(["link", "setText"])
    const next = applyOps(snapshot, ops, NOW)
    expect(next.nodes.get(OBJECT)?.props).toBe(featureProps(OBJECT_SPEC))
    expect(boardFeatures(next, "b").map((s) => [s.feature.id, s.feature.label])).toEqual([
      [OBJECT, "Thing"],
      [LOCATION, "Location"],
    ])
    // And the walk back carries it, so the next edit starts from it.
    expect(noteDoc("b", next)?.blocks[OBJECT].props).toEqual(JSON.parse(featureProps(OBJECT_SPEC)))
  })
})
