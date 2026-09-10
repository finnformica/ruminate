import type { LinkRow, NodeRow } from "../../worker/handlers/replica-payload"
import { generateNKeysBetween } from "fractional-indexing"
import type { BlockType } from "../blocks/types"
import { CHILD_KIND, PAGE_TYPE, buildGraphSnapshot, propsJson, type GraphSnapshot } from "./graph"

/**
 * The signed-out corpus: a handful of typed blocks, hard-coded — the graph
 * the app shows before anyone signs in. No markdown, no parse: pages and
 * blocks are written here as the rows they are, and `sampleGraph()` builds
 * the snapshot the signed-out `graphSnapshotAtom` serves (edits apply to it
 * in memory and are gone on reload).
 */

interface SampleBlock {
  id: string
  type: BlockType
  text: string
  children?: SampleBlock[]
}

interface SamplePage {
  id: string
  title: string
  props?: Record<string, unknown>
  blocks: SampleBlock[]
}

const b = (
  id: string,
  type: BlockType,
  text: string,
  children: SampleBlock[] = [],
): SampleBlock => ({ id, type, text, children })

const PAGES: SamplePage[] = [
  {
    id: "readme",
    title: "👋 Welcome to Ruminate",
    props: { tags: ["ruminate/welcome"], pinned: true },
    blocks: [
      b(
        "blk_welcome001",
        "text",
        "Ruminate is a note-taking app: a graph of blocks, kept in your own database and synced across your devices.",
      ),
      b(
        "blk_welcome002",
        "text",
        "Think of Ruminate as your _private knowledge garden_. It's where you plant, grow, and harvest ideas.",
      ),
      b(
        "blk_welcome003",
        "ul",
        "🌱 **Plant**: Capture notes as blocks — an outline you can fold, zoom into and rearrange. Your data is never locked in.",
      ),
      b(
        "blk_welcome004",
        "ul",
        "🌿 **Grow**: Connect your notes with links and tags. A block can live in more than one place at once.",
      ),
      b(
        "blk_welcome005",
        "ul",
        "🧑‍🌾 **Harvest**: Access your notes from any device, even offline. Use Ruminate's flexible search syntax to find what you're looking for.",
        [b("blk_welcome006", "todo", "Try folding this list, or press F on a block to zoom in")],
      ),
      b(
        "blk_welcome007",
        "text",
        "You're currently viewing Ruminate signed out: edits stay in this tab. When you're ready to keep notes, sign in with GitHub.",
      ),
    ],
  },
]

/** The sample corpus as rows (fresh, evenly spaced sort keys). */
export function sampleRows(now = 0): { nodes: NodeRow[]; links: LinkRow[] } {
  const nodes: NodeRow[] = []
  const links: LinkRow[] = []
  const walk = (parentId: string, blocks: SampleBlock[]) => {
    const keys = generateNKeysBetween(null, null, blocks.length)
    blocks.forEach((block, i) => {
      nodes.push({ id: block.id, type: block.type, text: block.text, props: null, updated_at: now })
      links.push({
        source_id: parentId,
        destination_id: block.id,
        kind: CHILD_KIND,
        sort_key: keys[i],
        updated_at: now,
      })
      walk(block.id, block.children ?? [])
    })
  }
  for (const page of PAGES) {
    nodes.push({
      id: page.id,
      type: PAGE_TYPE,
      text: page.title,
      props: propsJson(page.props ?? null),
      updated_at: now,
    })
    walk(page.id, page.blocks)
  }
  return { nodes, links }
}

/** The sample corpus as a snapshot. */
export function sampleGraph(): GraphSnapshot {
  const { nodes, links } = sampleRows()
  return buildGraphSnapshot(nodes, links)
}
