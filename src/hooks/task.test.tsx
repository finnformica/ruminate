// @vitest-environment jsdom
import { renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useMoveTask } from "./task"

const { writeNotes, noteContents } = vi.hoisted(() => ({
  writeNotes: vi.fn(),
  noteContents: {} as Record<string, string>,
}))

vi.mock("../data/store", () => ({
  useGetNoteContents: () => () => noteContents,
  useWriteNotes: () => writeNotes,
}))

beforeEach(() => {
  writeNotes.mockClear()
  for (const key of Object.keys(noteContents)) delete noteContents[key]
})

describe("useMoveTask", () => {
  it("writes both notes through the store directly (no drafts)", () => {
    const sourceMarkdown = "- [ ] task one\n- [ ] task two\n"
    noteContents["source-note"] = sourceMarkdown
    noteContents["target-note"] = "existing\n"

    const { result } = renderHook(() => useMoveTask())
    result.current({
      sourceNoteId: "source-note",
      targetNoteId: "target-note",
      sourceMarkdown,
      nodeStart: 0,
      nodeEnd: 14,
    })

    // One store write persists both sides, each stamped with updated_at in
    // the canonical form (no blank line after the frontmatter fence).
    expect(writeNotes).toHaveBeenCalledTimes(1)
    expect(writeNotes).toHaveBeenCalledWith({
      "source-note": expect.stringMatching(/^---\nupdated_at: .+\n---\n- \[ \] task two\n$/),
      "target-note": expect.stringMatching(
        /^---\nupdated_at: .+\n---\nexisting\n\n- \[ \] task one$/,
      ),
    })
  })

  it("appends to a trailing list in the target without a blank separator", () => {
    const sourceMarkdown = "- [ ] task one\n"
    noteContents["source-note"] = sourceMarkdown
    noteContents["target-note"] = "- [ ] already here\n"

    const { result } = renderHook(() => useMoveTask())
    result.current({
      sourceNoteId: "source-note",
      targetNoteId: "target-note",
      sourceMarkdown,
      nodeStart: 0,
      nodeEnd: 14,
    })

    expect(writeNotes).toHaveBeenCalledWith({
      "source-note": expect.stringMatching(/^---\nupdated_at: .+\n---\n$/),
      "target-note": expect.stringMatching(
        /^---\nupdated_at: .+\n---\n- \[ \] already here\n- \[ \] task one$/,
      ),
    })
  })
})
