import { StoryObj } from "@storybook/react"
import { expect, within } from "@storybook/test"
import { NoteFavicon } from "./note-favicon"
import { buildGraphSnapshot, docToGraph } from "../data/graph"
import { noteFromPage } from "../data/note-meta"
import type { Note } from "../schema"

/** A note from markdown, exactly as the app derives one for a page. */
function parseNote(
  id: string,
  markdown: string,
  props: Record<string, unknown> | null = null,
): Note {
  const { nodes, links } = docToGraph(id, markdown, 0, props)
  return noteFromPage(id, buildGraphSnapshot(nodes, links)) as Note
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

export const IsDailyNote: Story = {
  args: {
    note: parseNote("2023-07-11", ""),
  },
  play: async ({ canvasElement }) => expectFavicon(canvasElement, "favicon-daily"),
}

export const IsWeeklyNote: Story = {
  args: {
    note: parseNote("2023-W07", ""),
  },
  play: async ({ canvasElement }) => expectFavicon(canvasElement, "favicon-weekly"),
}

export const HasUrl: Story = {
  args: {
    note: parseNote("1", `# [Google](https://google.com)`),
  },
  play: async ({ canvasElement }) => expectFavicon(canvasElement, "favicon-url"),
}

export const HasGithub: Story = {
  args: {
    note: parseNote("1", "# Cole Bemis", { github: "colebemis" }),
  },
  play: async ({ canvasElement }) => expectFavicon(canvasElement, "favicon-github"),
}

const expectFavicon = async (canvasElement: HTMLElement, favicon: string) => {
  const canvas = within(canvasElement)
  await expect(await canvas.findByTestId(favicon)).toBeTruthy()
}
