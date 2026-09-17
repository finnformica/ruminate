import { StoryObj } from "@storybook/react"
import { useState } from "react"
import { parse } from "../../blocks/parse"
import type { BlockDoc } from "../../blocks/types"
import { BlockEditor } from "./block-editor"
import { NoteTitle } from "./note-title"

/** Stateful harness: renaming updates the name so the story reflects the edit. */
function Harness({ initial }: { initial: string }) {
  const [name, setName] = useState(initial)
  return (
    <div style={{ maxWidth: 640, padding: 24 }}>
      <NoteTitle
        title={name}
        onRename={(next) => {
          setName(next)
          return true
        }}
      />
      <pre data-testid="note-name" style={{ position: "fixed", left: -9999, top: 0 }} aria-hidden>
        {name}
      </pre>
    </div>
  )
}

export default {
  title: "NoteTitle",
  component: Harness,
}

type Story = StoryObj<typeof Harness>

export const Default: Story = {
  args: { initial: "Meeting notes" },
}

/** A note someone shared without write: the same heading, never editable. */
export const ReadOnly: Story = {
  render: () => (
    <div style={{ maxWidth: 640, padding: 24 }}>
      <NoteTitle title="Their meeting notes" onRename={() => false} readOnly />
    </div>
  ),
}

/** The title above the block editor, mirroring the note page layout (the wide
 * page's 40px gutter and its header pull, `--note-header-pull`), to check the
 * title is the largest header and hangs into the gutter ahead of the blocks.
 * In focus, the page hides the title: the breadcrumb and the focus title hang in
 * its place. */
function PageHarness({ focusRootId }: { focusRootId?: string }) {
  const [name, setName] = useState("Nvidia Sync")
  const [doc, setDoc] = useState<BlockDoc>(() =>
    parse(
      "# 20-08-2026\n  id:: blk_h1\n## A second-level heading\n  id:: blk_h2\nsome paragraph text\n  id:: blk_p\n- a bullet\n  id:: blk_b\n",
    ),
  )
  return (
    <div className="[--note-header-pull:27px]" style={{ maxWidth: 700, padding: 40 }}>
      <div className="flex flex-col gap-3">
        {focusRootId ? null : (
          <NoteTitle
            title={name}
            onRename={(next) => {
              setName(next)
              return true
            }}
          />
        )}
        <BlockEditor doc={doc} onChange={setDoc} focusRootId={focusRootId} noteTitle={name} />
      </div>
    </div>
  )
}

export const OnPage: Story = {
  render: () => <PageHarness />,
}

export const OnPageFocused: Story = {
  render: () => <PageHarness focusRootId="blk_h1" />,
}
