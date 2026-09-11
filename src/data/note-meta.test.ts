import { describe, expect, it } from "vitest"
import { parse } from "../blocks/parse"
import { serialize } from "../blocks/serialize"
import { buildGraphSnapshot, docToGraph, type GraphSnapshot } from "./graph"
import {
  createNotesBuilder,
  noteFromPage,
  pagePropsEntries,
  pagePropsOps,
  tagsInText,
} from "./note-meta"
import { applyOps } from "./ops"

/** A page fixture: its markdown body, with its metadata as props (never as
 * frontmatter — metadata does not travel in markdown). */
type Page = string | { markdown: string; props: Record<string, unknown> }

function graphOf(pages: Record<string, Page>): GraphSnapshot {
  const nodes = []
  const links = []
  for (const [id, page] of Object.entries(pages)) {
    const { markdown, props } = typeof page === "string" ? { markdown: page, props: null } : page
    const g = docToGraph(id, serialize(parse(markdown)), 1, props)
    nodes.push(...g.nodes)
    links.push(...g.links)
  }
  return buildGraphSnapshot(nodes, links)
}

const note = (id: string, markdown: string, props?: Record<string, unknown>) =>
  noteFromPage(id, graphOf({ [id]: props ? { markdown, props } : markdown }))!

describe("tagsInText", () => {
  it("find inline tags as the syntax defines them, parents included", () => {
    expect(tagsInText("a #foo/bar b #x_1 not#this #-no")).toEqual(["foo", "foo/bar", "x_1"])
    expect(tagsInText("#Ünïcode #中文")).toEqual(["Ünïcode", "中文"])
  })
})

describe("noteFromPage", () => {
  it("reads title, props, tags, dates, tasks, headings and text off the graph", () => {
    const n = note(
      "blk_p",
      [
        "# Heading one #inline",
        "  [ ] buy milk !!2 #home",
        "  [x] ship it",
        "  ## Sub",
        "- plain #tag/child",
      ].join("\n"),
      {
        title: "Plan",
        tags: ["work/q3"],
        pinned: true,
        due: "2026-03-04T00:00:00.000Z",
        updated_at: "2026-01-02T03:04:05.000Z",
      },
    )
    expect(n.title).toBe("Plan")
    expect(n.displayName).toBe("Plan")
    expect(n.pinned).toBe(true)
    expect(n.props.pinned).toBe(true)
    expect(n.tags).toEqual(["work", "work/q3", "inline", "home", "tag", "tag/child"])
    expect(n.dates).toContain("2026-03-04")
    expect(n.updatedAt).toBe(Date.parse("2026-01-02T03:04:05.000Z"))
    expect(n.tasks).toEqual([
      expect.objectContaining({
        completed: false,
        text: "buy milk !!2 #home",
        tags: ["home"],
      }),
      expect.objectContaining({ completed: true, text: "ship it" }),
    ])
    expect(n.tasks[0].blockId).toMatch(/^blk_/)
    expect(n.headings).toEqual([
      { level: 1, text: "Heading one #inline" },
      { level: 2, text: "Sub" },
    ])
    expect(n.text).toContain("buy milk")
    expect(n.type).toBe("note")
  })

  it("falls back to the first heading for the title", () => {
    const n = note("blk_p", "# Google\n- x\n")
    expect(n.title).toBe("Google")
  })

  it("names an untitled note by its first words, and a daily note by its date", () => {
    const n = note("blk_p", "- the quick brown fox jumps over the lazy dog again\n")
    expect(n.displayName).toBe("the quick brown fox jumps over the lazy…")
    expect(note("blk_p", "").displayName).toBe("Empty note")
    const daily = note("2026-03-04", "- x\n")
    expect(daily.type).toBe("daily")
    expect(daily.dates).toContain("2026-03-04")
    expect(daily.displayName).not.toBe("")
    expect(note("2026-W10", "").type).toBe("weekly")
  })

  it("is null for a block id", () => {
    const snapshot = graphOf({ p: "- b\n  id:: blk_b000000000\n" })
    expect(noteFromPage("blk_b000000000", snapshot)).toBeNull()
  })
})

describe("page props", () => {
  it("pagePropsEntries reads the entries shape; the retired raw-YAML shape reads as none", () => {
    expect(pagePropsEntries('{"pinned":true}')).toEqual({ pinned: true })
    expect(pagePropsEntries('{"frontmatter":"pinned: true\\nx: 1"}')).toEqual({})
    expect(pagePropsEntries(null)).toEqual({})
  })

  it("pagePropsOps merges, removes null keys, and stamps updated_at", () => {
    const snapshot = graphOf({ p: { markdown: "- x\n", props: { pinned: true, width: "full" } } })
    const ops = pagePropsOps("p", { pinned: null, font: "serif" }, snapshot)
    expect(ops).toHaveLength(1)
    const next = applyOps(snapshot, ops, 5)
    const entries = pagePropsEntries(next.nodes.get("p")!.props)
    expect(entries.pinned).toBeUndefined()
    expect(entries).toMatchObject({ width: "full", font: "serif" })
    expect(typeof entries.updated_at).toBe("string")
    expect(pagePropsOps("nope", {}, snapshot)).toEqual([])
  })
})

describe("createNotesBuilder", () => {
  it("keeps a Note object while its page's rows are unchanged, re-derives when they change", () => {
    const build = createNotesBuilder()
    const snapshot = graphOf({
      a: "- a\n  id:: blk_a000000000\n",
      b: "- b\n  id:: blk_b000000000\n",
    })
    const first = build(snapshot)
    const edited = applyOps(snapshot, [{ op: "setText", id: "blk_a000000000", text: "a!" }], 2)
    const second = build(edited)
    expect(second.get("b")).toBe(first.get("b"))
    expect(second.get("a")).not.toBe(first.get("a"))
    expect(second.get("a")?.text).toBe("a!")
    // A deleted page is evicted.
    const gone = build(applyOps(edited, [{ op: "delete", id: "a" }], 3))
    expect(gone.has("a")).toBe(false)
    expect(gone.get("b")).toBe(first.get("b"))
  })
})
