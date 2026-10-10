import { StoryObj } from "@storybook/react"
import { expect, within } from "@storybook/test"
import { NoteFavicon } from "./note-favicon"
import { buildGraphSnapshot, docToGraph } from "../data/graph"
import { noteFromNode } from "../data/note-meta"
import type { Note } from "../schema"

/** A note from markdown, exactly as the app derives one for a note node. */
function parseNote(id: string, markdown: string): Note {
  const { nodes, links } = docToGraph(id, markdown, 0)
  return noteFromNode(id, buildGraphSnapshot(nodes, links)) as Note
}

export default {
  title: "NoteFavicon",
  component: NoteFavicon,
  parameters: {
    layout: "centered",
  },
}

type Story = StoryObj<typeof NoteFavicon>

export const Default: Story = {
  args: {
    note: parseNote("1", ""),
  },
  play: async ({ canvasElement }) => expectFavicon(canvasElement, "favicon-default"),
}

const expectFavicon = async (canvasElement: HTMLElement, favicon: string) => {
  const canvas = within(canvasElement)
  await expect(await canvas.findByTestId(favicon)).toBeTruthy()
}
