import { describe, expect, test } from "vitest"
import type { Note } from "../schema"
import type { BlockHit } from "./block-search"
import { rankResultRows } from "./rank-results"

const note = (id: string): Note =>
  ({
    id,
    type: "note",
    displayName: id,
    props: {},
    title: id,
    pinned: false,
    updatedAt: null,
    dates: [],
    tasks: [],
    headings: [],
    text: "",
  }) as unknown as Note

const hit = (blockId: string, score?: number): BlockHit =>
  ({
    blockId,
    noteId: "n",
    text: blockId,
    type: "text",
    ancestors: [],
    note: note("n"),
    score,
  }) as BlockHit

describe("rankResultRows", () => {
  test("ranks title-matched notes and block hits together, purely by score", () => {
    const rows = rankResultRows(
      [
        { note: note("nvidia"), score: 1 },
        { note: note("nvda"), score: 0.6 },
      ],
      [hit("blk_exact", 1), hit("blk_close", 0.85), hit("blk_far", 0.5)],
    )
    expect(rows.map((row) => [row.kind, row.id])).toEqual([
      ["note", "nvidia"],
      ["block", "blk_exact"],
      ["block", "blk_close"],
      ["note", "nvda"],
      ["block", "blk_far"],
    ])
  })

  test("a tie keeps the order given, the note before the block", () => {
    const rows = rankResultRows([{ note: note("a"), score: 0.9 }], [hit("b", 0.9), hit("c", 0.9)])
    expect(rows.map((row) => row.id)).toEqual(["a", "b", "c"])
  })

  test("an unscored hit (a bare type: filter) ranks last, in document order", () => {
    const rows = rankResultRows([], [hit("first"), hit("second"), hit("scored", 0.3)])
    expect(rows.map((row) => row.id)).toEqual(["scored", "first", "second"])
  })

  test("an explicit sort: keeps the query's order — the notes as sorted, then the hits", () => {
    const rows = rankResultRows(
      [{ note: note("z"), score: 0.5 }],
      [hit("a", 1), hit("b", 0.9)],
      true,
    )
    expect(rows.map((row) => row.id)).toEqual(["z", "a", "b"])
  })

  test("carries the note id a block row opens into", () => {
    const [row] = rankResultRows([], [hit("blk", 1)])
    expect(row).toEqual({ id: "blk", noteId: "n", kind: "block", score: 1 })
  })
})
