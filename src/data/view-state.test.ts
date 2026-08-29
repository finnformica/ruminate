import { describe, expect, it } from "vitest"
import {
  applyCollapseOverrides,
  readCollapseOverrides,
  toggleCollapseOverride,
  type CollapseOverrides,
} from "./view-state"

const defaults = new Set(["blk_deep1", "blk_deep2"])
const none: CollapseOverrides = { expanded: [], collapsed: [] }

describe("applyCollapseOverrides", () => {
  it("with no overrides, the defaults are the collapsed set", () => {
    expect(applyCollapseOverrides(defaults, none)).toEqual(defaults)
  })

  it("expansions remove default-collapsed ids; collapses add expanded ids", () => {
    expect(
      applyCollapseOverrides(defaults, { expanded: ["blk_deep1"], collapsed: ["blk_top"] }),
    ).toEqual(new Set(["blk_deep2", "blk_top"]))
  })
})

describe("toggleCollapseOverride", () => {
  it("collapsing a default-expanded block records a collapse override", () => {
    const next = toggleCollapseOverride(defaults, none, "blk_top")
    expect(next).toEqual({ expanded: [], collapsed: ["blk_top"] })
    expect(applyCollapseOverrides(defaults, next).has("blk_top")).toBe(true)
  })

  it("expanding a default-collapsed block records an expand override", () => {
    const next = toggleCollapseOverride(defaults, none, "blk_deep1")
    expect(next).toEqual({ expanded: ["blk_deep1"], collapsed: [] })
    expect(applyCollapseOverrides(defaults, next).has("blk_deep1")).toBe(false)
  })

  it("toggling twice returns to no overrides (fold-then-unfold is clean)", () => {
    let overrides = none
    overrides = toggleCollapseOverride(defaults, overrides, "blk_top")
    overrides = toggleCollapseOverride(defaults, overrides, "blk_top")
    expect(overrides).toEqual(none)

    overrides = toggleCollapseOverride(defaults, overrides, "blk_deep1")
    overrides = toggleCollapseOverride(defaults, overrides, "blk_deep1")
    expect(overrides).toEqual(none)
  })
})

describe("readCollapseOverrides", () => {
  it("degrades to no overrides without a note id or storage entry", () => {
    expect(readCollapseOverrides(undefined)).toEqual(none)
    expect(readCollapseOverrides("nothing-stored")).toEqual(none)
  })

  it("tolerates malformed storage", () => {
    localStorage.setItem("collapse:bad", "[not json")
    expect(readCollapseOverrides("bad")).toEqual(none)
    localStorage.setItem("collapse:wrong-shape", JSON.stringify({ expanded: "x", collapsed: [1] }))
    expect(readCollapseOverrides("wrong-shape")).toEqual(none)
  })

  it("reads back a stored override record", () => {
    localStorage.setItem(
      "collapse:note-a",
      JSON.stringify({ expanded: ["blk_a"], collapsed: ["blk_b"] }),
    )
    expect(readCollapseOverrides("note-a")).toEqual({ expanded: ["blk_a"], collapsed: ["blk_b"] })
  })
})
