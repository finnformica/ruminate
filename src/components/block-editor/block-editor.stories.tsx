import { StoryObj } from "@storybook/react"
import { expect, userEvent, waitFor, within } from "@storybook/test"
import { useState } from "react"
import { emptyBlock } from "../../blocks/ops"
import { parse } from "../../blocks/parse"
import { serialize } from "../../blocks/serialize"
import type { BlockDoc } from "../../blocks/types"
import { BlockEditor } from "./block-editor"

/** Ensure a parsed doc always has at least one block to edit. */
function withStarterBlock(doc: BlockDoc): BlockDoc {
  if (doc.rootBlockIds.length > 0) return doc
  const block = emptyBlock()
  return { ...doc, rootBlockIds: [block.id], blocks: { [block.id]: block } }
}

/**
 * Stateful harness so the block editor can be exercised in isolation (no auth,
 * no GitHub). The serialized markdown is exposed for assertions.
 */
function Harness({
  initial,
  startEditing,
  zoomRootId,
}: {
  initial: string
  startEditing?: boolean
  /** Start zoomed into this block (transient local zoom — no router). */
  zoomRootId?: string | null
}) {
  const [doc, setDoc] = useState<BlockDoc>(() => withStarterBlock(parse(initial)))
  return (
    <div style={{ maxWidth: 640, padding: 24 }}>
      <BlockEditor
        doc={doc}
        onChange={setDoc}
        startEditing={startEditing}
        zoomRootId={zoomRootId}
        noteTitle="My note"
      />
      <pre data-testid="serialized" style={{ position: "fixed", left: -9999, top: 0 }} aria-hidden>
        {serialize(doc)}
      </pre>
    </div>
  )
}

const SAMPLE = `# Project ideas
  id:: blk_h1
Some intro text
  id:: blk_p1
- A bullet point
  id:: blk_b1
  - A nested bullet
    id:: blk_b2
[ ] A todo
  id:: blk_t1
[x] A done todo
  id:: blk_t2
> A quote
  id:: blk_q1
`

export default {
  title: "BlockEditor",
  component: Harness,
}

type Story = StoryObj<typeof Harness>

/** Visual reference: mixed block types render as a document, not an outline. */
export const Mixed: Story = {
  args: { initial: SAMPLE },
}

export const Empty: Story = {
  args: { initial: "" },
}

/** A todo that also has children — both shortcut hints stack when selected. */
export const NestedTodo: Story = {
  args: { initial: "[ ] Parent todo\n  id:: blk_pt\n  - child bullet\n    id:: blk_pc\n" },
}

/** Every block type in one document — used to audit the selected-state
 * highlight across types (select all via the Cmd+A ladder and screenshot). */
const SWEEP_SAMPLE = `# Alpha heading
  id:: blk_s1
Paragraph with \`inline code\` and a ((blk_sq)) transclusion
  id:: blk_s2
- Bullet parent
  id:: blk_s3
  # Nested heading
    id:: blk_s4
  - Deep bullet
    id:: blk_s5
- Collapsed sibling
  id:: blk_s6
  - Hidden child
    id:: blk_s7
1. First step
  id:: blk_s8
2. Second step
  id:: blk_s9
[ ] Open todo
  id:: blk_s10
[x] Done todo
  id:: blk_s11
> The quoted line, which is also transcluded above
  id:: blk_sq
A long wrapping paragraph to check tall highlights: the quick brown fox jumps over the lazy dog again and again until the line wraps onto a second and third visual line inside a single block.
  id:: blk_s12
`

export const SelectionSweep: Story = {
  args: { initial: SWEEP_SAMPLE },
}

/** A brand-new note opens with the first block already in edit mode. */
export const AutoFocus: Story = {
  args: { initial: "", startEditing: true },
}

const serialized = (canvasElement: HTMLElement) =>
  canvasElement.querySelector('[data-testid="serialized"]')?.textContent ?? ""

/** Typing `# ` promotes a block to a heading, and `- ` to a single bullet. */
export const MarkdownShortcuts: Story = {
  args: { initial: "" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    // The first (empty) block starts selected — Enter to edit it.
    await userEvent.keyboard("{Enter}")
    const textarea = await canvas.findByRole("textbox")
    await userEvent.type(textarea, "# Heading one")

    // Rendered as a heading (no visible `#`), serialized with one `# `.
    await waitFor(() => expect(serialized(canvasElement)).toContain("# Heading one"))

    // New paragraph, then a bullet — the bullet keeps exactly one `- `.
    await userEvent.keyboard("{Enter}")
    await userEvent.keyboard("- Bullet one")
    await waitFor(() => {
      const md = serialized(canvasElement)
      expect(md).toContain("- Bullet one")
      expect(md).not.toContain("- - Bullet one")
    })
  },
}

/**
 * Typing a marker at the start of an existing block switches its type,
 * replacing whatever marker it had — a checkbox becomes a bullet, then an
 * ordered item, then a heading.
 */
export const TypeSwitch: Story = {
  args: { initial: "[ ] A task\n  id:: blk_sw\n" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    // Starts as a todo with a checkbox.
    expect(await canvas.findByRole("checkbox")).toBeInTheDocument()

    // Edit it and type `- ` at the very start → bullet (no checkbox left).
    await userEvent.click(canvas.getByText("A task"))
    await userEvent.keyboard("{Enter}{Home}")
    await userEvent.type(canvas.getByRole("textbox"), "- ")
    await waitFor(() => {
      const md = serialized(canvasElement)
      expect(md).toContain("- A task")
      expect(md).not.toContain("[ ] A task")
    })
    expect(canvas.queryByRole("checkbox")).not.toBeInTheDocument()

    // `1. ` at the start → ordered item (bullet marker replaced).
    await userEvent.keyboard("{Home}")
    await userEvent.type(canvas.getByRole("textbox"), "1. ")
    await waitFor(() => {
      const md = serialized(canvasElement)
      expect(md).toContain("1. A task")
      expect(md).not.toContain("- A task")
    })

    // `# ` at the start → heading (ordered marker replaced).
    await userEvent.keyboard("{Home}")
    await userEvent.type(canvas.getByRole("textbox"), "# ")
    await waitFor(() => {
      const md = serialized(canvasElement)
      expect(md).toContain("# A task")
      expect(md).not.toContain("1. A task")
    })
  },
}

/** A todo shortcut renders an interactive checkbox. */
export const TodoShortcut: Story = {
  args: { initial: "" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.keyboard("{Enter}")
    const textarea = await canvas.findByRole("textbox")
    await userEvent.type(textarea, "[] Buy milk")
    await userEvent.keyboard("{Escape}")

    const checkbox = await canvas.findByRole("checkbox")
    expect(checkbox).not.toBeChecked()
    await userEvent.click(checkbox)
    await waitFor(() => expect(serialized(canvasElement)).toContain("[x] Buy milk"))
  },
}

/** The editor zoomed into a block: its subtree is the whole view, the block
 * itself is the editable title, and a breadcrumb traces the path. */
export const Zoomed: Story = {
  args: { initial: SAMPLE, zoomRootId: "blk_b1" },
}

/** F zooms into the selected block; Shift+F zooms back out, landing on it. */
export const ZoomKeys: Story = {
  args: { initial: SAMPLE },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    // Select the bullet (it has a nested child) and zoom in with F.
    await userEvent.click(canvas.getByText("A bullet point"))
    await userEvent.keyboard("f")
    const crumb = await within(canvasElement).findByTestId("zoom-breadcrumb")
    expect(crumb.textContent).toContain("A bullet point")
    // Only the zoomed subtree renders; the heading is gone…
    expect(canvas.queryByText("Project ideas")).not.toBeInTheDocument()
    // …and the first child is selected, ready for arrows.
    expect(canvas.getByText("A nested bullet")).toBeInTheDocument()

    // Shift+F zooms back out: the whole note again, no breadcrumb.
    await userEvent.keyboard("{Shift>}F{/Shift}")
    await waitFor(() =>
      expect(within(canvasElement).queryByTestId("zoom-breadcrumb")).not.toBeInTheDocument(),
    )
    expect(await canvas.findByText("Project ideas")).toBeInTheDocument()
  },
}

/** Arrow keys move a highlight; the text position is identical in view/edit. */
export const SeamlessViewEdit: Story = {
  args: { initial: SAMPLE },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    const heading = await canvas.findByText("Project ideas")
    const viewLeft = heading.getBoundingClientRect().left

    await userEvent.click(heading)
    await userEvent.keyboard("{Enter}")
    const textarea = await canvas.findByRole("textbox")
    const editLeft = textarea.getBoundingClientRect().left

    // Entering edit mode must not shift the text horizontally.
    expect(Math.abs(viewLeft - editLeft)).toBeLessThanOrEqual(2)
  },
}
