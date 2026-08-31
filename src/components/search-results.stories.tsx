import { StoryObj } from "@storybook/react"
import { useBlockResultTree } from "../hooks/block-result-tree"
import { useListKeyboardNav } from "../hooks/list-keyboard-nav"
import type { Note } from "../schema"
import { createBlockIndexer, searchBlocks, type BlockHit } from "../utils/block-search"
import { inMemoryBlockSearchSource } from "../utils/block-search-source"
import { parseQuery } from "../utils/search"
import { SearchResults } from "./search-results"

/**
 * The block-results list in its `page` chrome (the full results view). Rows
 * are the matching BLOCKS — expand one with the chevron, or with ↑/↓ then →,
 * to read the blocks inside it.
 */

function note(id: string, content: string): Note {
  return {
    id,
    content,
    type: "note",
    displayName: id,
    frontmatter: {},
    title: id,
    url: null,
    alias: null,
    aliases: [],
    pinned: false,
    updatedAt: null,
    dates: [],
    tags: [],
    tasks: [],
  }
}

const CORPUS = [
  note(
    "research",
    [
      "# Semiconductors",
      "  id:: blk_semis",
      "  - GPUs",
      "    id:: blk_gpus",
      "    # nvidia",
      "      id:: blk_nvidia",
      "      - H100 supply is the whole story",
      "        id:: blk_h100",
      "        - 80GB HBM3, allocated a year out",
      "          id:: blk_hbm",
      "      - datacenter revenue",
      "        id:: blk_rev",
      "",
    ].join("\n"),
  ),
  note(
    "2026-08-31",
    [
      "# Today",
      "  id:: blk_today",
      "  [ ] read the nvidia earnings call",
      "    id:: blk_read",
      "  [x] ship the search UI",
      "    id:: blk_ship",
      "  > the best results are the ones you don't have to click into",
      "    id:: blk_quote",
      "",
    ].join("\n"),
  ),
]

const index = createBlockIndexer()(CORPUS)
const source = inMemoryBlockSearchSource(index)

function Harness({ query }: { query: string }) {
  const hits: BlockHit[] = searchBlocks(parseQuery(query), index)
  const { rows, expand, collapse, toggle } = useBlockResultTree({ hits, source, resetKey: query })
  const { activeIndex, setActiveIndex, containerRef } = useListKeyboardNav({
    count: rows.length,
    resetKey: query,
    onActivate: () => {},
    onExpand: (i) => expand(rows[i]),
    onCollapse: (i) => {
      const row = rows[i]
      if (row.expanded) return collapse(row)
      const parent = rows.findIndex((other) => other.key === row.parentKey)
      if (parent !== -1) setActiveIndex(parent)
    },
  })
  return (
    <div ref={containerRef} style={{ maxWidth: 640, padding: 24 }}>
      <div className="mb-3 text-sm text-text-secondary">
        {hits.length} matching blocks — query: <code>{query}</code>
      </div>
      <SearchResults
        variant="page"
        rows={rows}
        activeIndex={activeIndex}
        onActivate={() => {}}
        onToggle={toggle}
      />
    </div>
  )
}

export default {
  title: "SearchResults",
  component: Harness,
}

type Story = StoryObj<typeof Harness>

/** A plain text query: the nested heading is a result in its own right. */
export const TextQuery: Story = {
  args: { query: "nvidia" },
}

/** A block-type filter across the corpus. */
export const TodoFilter: Story = {
  args: { query: "type:todo" },
}

/** Mixed types, showing how each block renders in its own style. */
export const MixedTypes: Story = {
  args: { query: "type:heading,todo,done,quote" },
}
