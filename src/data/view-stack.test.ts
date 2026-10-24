import { describe, expect, it } from "vitest"
import type { LinkRow, NodeRow } from "../../worker/handlers/replica-payload"
import { buildGraphSnapshot, CHILD_KIND, CORPUS_ROOT_ID } from "./graph"
import type { FocusFrame } from "./panes"
import { rootFrame } from "./root-frame"
import { parseViewStack, restoreViewFrames, stackToSave, viewPathHint } from "./view-stack"

/**
 * Views save a whole stack (docs/graph-walk.md, section 7), above the Root
 * frame. Finn's example: Notes › Tasks › Todos, where Tasks is a note and
 * Todos a heading in it, under the block Week.
 *
 *   Tasks › Week › Todos, and Projects › Todos (a second parent).
 */
const node = (id: string, text: string, type = "text"): NodeRow => ({
  id,
  type,
  text,
  props: null,
  updated_at: 0,
})
const link = (source: string, destination: string): LinkRow => ({
  source_id: source,
  destination_id: destination,
  kind: CHILD_KIND,
  sort_key: "a0",
  updated_at: 0,
})
const graphOf = (links: LinkRow[]) =>
  buildGraphSnapshot(
    [
      node("blk_tasks", "Tasks", "note"),
      node("blk_proj", "Projects", "note"),
      node("blk_week", "Week"),
      node("blk_todos", "Todos", "h2"),
    ],
    links,
  )
const GRAPH = graphOf([
  link("blk_tasks", "blk_week"),
  link("blk_week", "blk_todos"),
  link("blk_proj", "blk_todos"),
])

const frame = (
  noteId: string,
  root: string | null,
  extra: Partial<FocusFrame> = {},
): FocusFrame => ({
  noteId,
  root,
  selected: null,
  ...extra,
})

describe("Save as view", () => {
  it("saves the frames above Root up to the one on screen, without selections or folds", () => {
    const saved = stackToSave([
      rootFrame(),
      frame("blk_tasks", null, {
        selected: ["blk_week", "blk_todos"],
        filter: "type:h2",
        folds: { open: ["blk_week"], closed: [] },
      }),
      frame("blk_tasks", "blk_todos", { pivots: { blk_todos: "up" } }),
    ])
    expect(saved.rootId).toBe("blk_todos")
    expect(saved.stack).toBe("blk_tasks;f=type%3Ah2,blk_tasks:blk_todos;p=^todos")
  })

  it("saves a lone frame with no pivots as a one-frame View: no stack", () => {
    expect(stackToSave([rootFrame(), frame("blk_tasks", null)])).toEqual({
      rootId: "blk_tasks",
      stack: null,
    })
  })

  it("never saves Root", () => {
    const saved = stackToSave([
      rootFrame(),
      frame("blk_tasks", null),
      frame("blk_tasks", "blk_todos"),
    ])
    expect(saved.stack).not.toContain(CORPUS_ROOT_ID)
  })
})

describe("the stack field read back", () => {
  it("round-trips: the lower frames, base first, and the top's pivots", () => {
    const saved = stackToSave([
      rootFrame(),
      frame("blk_tasks", null, { filter: "type:h2" }),
      frame("blk_tasks", "blk_todos", { pivots: { blk_todos: "up" } }),
    ])
    expect(parseViewStack(saved.stack, "blk_todos")).toEqual({
      lower: [frame("blk_tasks", null, { filter: "type:h2" })],
      topPivots: { blk_todos: "up" },
    })
  })

  it("ignores a Root entry and a malformed one", () => {
    expect(
      parseViewStack("corpus_root,blk_tasks,a:b:c:d,blk_tasks:blk_todos", "blk_todos"),
    ).toEqual({
      lower: [frame("blk_tasks", null)],
      topPivots: undefined,
    })
  })

  it("reads nothing from an empty field", () => {
    expect(parseViewStack(null, "blk_tasks")).toEqual({ lower: [], topPivots: undefined })
  })
})

describe("open a View", () => {
  const view = (stack: string | null) => ({
    rootId: "blk_todos",
    noteId: "blk_tasks",
    stack,
  })
  const threeFrames = stackToSave([
    rootFrame(),
    frame("blk_tasks", null, { filter: "type:h2" }),
    frame("blk_tasks", "blk_todos"),
  ]).stack

  it("restores Root, then the saved frames, the top on screen", () => {
    const frames = restoreViewFrames(view(threeFrames), GRAPH)
    expect(frames).toEqual([
      rootFrame(),
      frame("blk_tasks", null, {
        filter: "type:h2",
        // The path down to the next frame's root, opened, as Back lands on it.
        selected: ["blk_week", "blk_todos"],
        folds: { open: ["blk_week"], closed: [] },
      }),
      frame("blk_tasks", "blk_todos"),
    ])
  })

  it("follows the saved path where a block has two parents", () => {
    const viaProjects = stackToSave([
      rootFrame(),
      frame("blk_proj", null),
      frame("blk_tasks", "blk_todos"),
    ]).stack
    const frames = restoreViewFrames(view(viaProjects), GRAPH)
    expect(frames?.map((f) => f.noteId)).toEqual([CORPUS_ROOT_ID, "blk_proj", "blk_tasks"])
    expect(frames?.[1].selected).toEqual(["blk_todos"])
  })

  it("opens a one-frame View as Notes › its root", () => {
    expect(restoreViewFrames(view(null), GRAPH)).toEqual([
      rootFrame(),
      frame("blk_tasks", "blk_todos"),
    ])
  })

  it("restores the top frame's pivots", () => {
    const pivoted = stackToSave([
      rootFrame(),
      frame("blk_tasks", "blk_todos", { pivots: { blk_todos: "up" } }),
    ]).stack
    expect(restoreViewFrames(view(pivoted), GRAPH)?.[1].pivots).toEqual({ blk_todos: "up" })
  })

  it("drops a frame whose root no longer reaches the frame above, and every frame below it", () => {
    // Todos moved out of Tasks: Week no longer holds it.
    const moved = graphOf([link("blk_tasks", "blk_week"), link("blk_proj", "blk_todos")])
    const saved = stackToSave([
      rootFrame(),
      frame("blk_tasks", null),
      frame("blk_tasks", "blk_week"),
      frame("blk_tasks", "blk_todos"),
    ]).stack
    expect(restoreViewFrames(view(saved), moved)).toEqual([
      rootFrame(),
      frame("blk_tasks", "blk_todos"),
    ])
  })

  it("keeps the frames above a break", () => {
    // The base frame's note is gone; Week still holds Todos.
    const saved = stackToSave([
      rootFrame(),
      frame("blk_gone", null),
      frame("blk_tasks", "blk_week"),
      frame("blk_tasks", "blk_todos"),
    ]).stack
    const frames = restoreViewFrames(view(saved), GRAPH)
    expect(frames?.map((f) => f.root ?? f.noteId)).toEqual([
      CORPUS_ROOT_ID,
      "blk_week",
      "blk_todos",
    ])
  })

  it("leaves out a View whose top root is gone", () => {
    expect(restoreViewFrames({ rootId: "blk_gone", noteId: "blk_tasks" }, GRAPH)).toBeNull()
  })
})

describe("the path hint (docs/graph-walk.md, section 7)", () => {
  it("names the frames between Notes and the top, from Notes", () => {
    const frames = [
      rootFrame(),
      frame("blk_tasks", null),
      frame("blk_tasks", "blk_week"),
      frame("blk_tasks", "blk_todos"),
    ]
    expect(viewPathHint(frames, GRAPH)).toBe("Notes › Tasks › Week")
  })

  it("is empty for a one-frame View", () => {
    expect(viewPathHint([rootFrame(), frame("blk_tasks", "blk_todos")], GRAPH)).toBe("")
  })
})
