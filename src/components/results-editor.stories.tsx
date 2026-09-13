import type { StoryObj } from "@storybook/react"
import { Provider, createStore } from "jotai"
import { parse } from "../blocks/parse"
import { serialize } from "../blocks/serialize"
import { buildGraphSnapshot, docToGraph } from "../data/graph"
import { sampleGraphAtom } from "../global-state"
import type { ResultRoot } from "../hooks/results-doc"
import { ResultsEditor } from "./results-editor"

/** A small corpus with the shapes search finds: nested headings, todos, a
 * quote, and two notes. Ids are pinned so the roots can be named. */
const CORPUS: Record<string, string> = {
  research: [
    "# Semiconductors",
    "  id:: blk_semis",
    "  - GPUs",
    "    id:: blk_gpus",
    "    - nvidia",
    "      id:: blk_nvidia",
    "      - H100 supply",
    "        id:: blk_h100",
    "      - datacenter revenue",
    "        id:: blk_rev",
    "- [ ] buy milk",
    "  id:: blk_milk",
    "",
  ].join("\n"),
  journal: [
    "- [ ] read the graph schema",
    "  id:: blk_read",
    "- [x] ship the search UI",
    "  id:: blk_ship",
    "- > the best results are the ones you don't have to click into",
    "  id:: blk_quote",
    "",
  ].join("\n"),
}

const store = createStore()
{
  const nodes = []
  const links = []
  for (const [id, markdown] of Object.entries(CORPUS)) {
    const g = docToGraph(id, serialize(parse(markdown)), 1)
    nodes.push(...g.nodes)
    links.push(...g.links)
  }
  store.set(sampleGraphAtom, buildGraphSnapshot(nodes, links))
}

const NOTES: ResultRoot[] = Object.keys(CORPUS).map((id) => ({ id, noteId: id }))
const TODOS: ResultRoot[] = [
  { id: "blk_milk", noteId: "research" },
  { id: "blk_read", noteId: "journal" },
  { id: "blk_ship", noteId: "journal" },
]
const NVIDIA: ResultRoot[] = [{ id: "blk_nvidia", noteId: "research" }]

function Harness({ roots, readOnly }: { roots: ResultRoot[]; readOnly: boolean }) {
  return (
    <Provider store={store}>
      <div style={{ maxWidth: 640, padding: 24 }}>
        <ResultsEditor
          roots={roots}
          resetKey="story"
          readOnly={readOnly}
          onOpen={(noteId, blockId) => console.log("open", noteId, blockId)}
        />
      </div>
    </Provider>
  )
}

export default {
  title: "ResultsEditor",
  component: Harness,
}

type Story = StoryObj<typeof Harness>

/** The notes list: every note a closed root, browsed (Enter / click opens). */
export const NotesList: Story = {
  args: { roots: NOTES, readOnly: true },
}

/** A `type:todo` search, editable: tick one and it lands in its note. */
export const TodoResults: Story = {
  args: { roots: TODOS, readOnly: false },
}

/** A text query's one nested hit, editable, with its subtree to open. */
export const NestedHit: Story = {
  args: { roots: NVIDIA, readOnly: false },
}
