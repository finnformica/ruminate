import type { LinkRow, NodeRow } from "../../worker/handlers/replica-payload"
import {
  buildGraphSnapshot,
  CORPUS_ROOT_ID,
  NOTE_TYPES,
  ROOT_TYPE,
  type GraphSnapshot,
} from "./graph"
import { linkEntityId } from "./events"
import type { NoteStore } from "./note-store"
import { currentFrame, layoutFromSearch } from "./panes"
import { isRootFrame, ROOT_DEPTH } from "./root-frame"

/**
 * **The first screen** (docs/event-sourcing.md, "The boot read"): what a
 * reload reads before it draws, so the page does not wait for the whole
 * graph. The runtime reads the whole graph straight after
 * (`src/data/database-mode.ts`), and that graph replaces this one.
 *
 * The walk lists a child only when its node is in the graph (`walkGraph`),
 * and a closed row needs its children to draw its chevron. So a frame is
 * read one level past its depth: the rows it draws, and the children of its
 * closed rows. Each child list it reads is the node's complete list
 * (`childLinksOf` of the source), so the walk draws each drawn row as the
 * whole graph draws it. The one exception is the Root frame at its own depth:
 * its note rows are closed, and each note gets only its first child
 * (`firstChildLinksOf`), which draws the chevron. A note's top-level blocks
 * can be most of the corpus.
 */

/** A frame on screen at boot: the node its walk starts from (a note, a
 * focused block, or the corpus root for the Root frame), and the levels it
 * opens. */
export interface FirstScreenFrame {
  id: string
  depth: number
}

/**
 * The frames on screen at boot, read off the address as the views page reads
 * it (`layoutFromSearch`): the frame on top of each pane. A page other than
 * a view (the calendar, Settings) has none: its first screen is the notes.
 */
export function framesOnScreen(
  location: { pathname: string; search: string },
  expandedLevels: number,
): FirstScreenFrame[] {
  const path = location.pathname.replace(/\/+$/, "")
  if (path === "") return [{ id: CORPUS_ROOT_ID, depth: ROOT_DEPTH }]
  const match = /^\/views\/(.+)$/.exec(path)
  if (!match) return []
  const search: Record<string, unknown> = {}
  for (const [key, value] of new URLSearchParams(location.search)) search[key] = searchValue(value)
  const layout = layoutFromSearch(decodeURIComponent(match[1]), search)
  return layout.panes.map((pane) => {
    const frame = currentFrame(pane)
    const root = isRootFrame(frame)
    return {
      id: frame.root ?? frame.noteId,
      depth: frame.depth ?? (root ? ROOT_DEPTH : expandedLevels),
    }
  })
}

/** A search value as the router reads it: JSON when it parses as JSON, else
 * the text itself. */
function searchValue(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * Read the first screen from the store: every note and board (the Root
 * frame's rows, the sidebar, the palette's list, and what tells a note that
 * exists from a new one), the corpus root and its order, the roots of the
 * views, and each frame's rows to one level past its depth.
 */
export async function loadFirstScreen(
  store: Pick<NoteStore, "nodesOfType" | "nodesOf" | "childLinksOf" | "firstChildLinksOf">,
  frames: readonly FirstScreenFrame[],
  viewRoots: readonly string[],
): Promise<GraphSnapshot> {
  const nodes = new Map<string, NodeRow>()
  const links: LinkRow[] = []
  // Each node whose child list is read, with that list: a frame that walks
  // through it again descends without reading it twice.
  const childIds = new Map<string, string[]>()
  for (const node of await store.nodesOfType([...NOTE_TYPES, ROOT_TYPE])) nodes.set(node.id, node)
  const notes = [...nodes.keys()].filter((id) => id !== CORPUS_ROOT_ID)

  /** Read the child lists of `ids`, and the nodes they name, `levels` deep. */
  const readBeneath = async (ids: readonly string[], levels: number) => {
    let frontier = [...new Set(ids)]
    for (let level = 0; level < levels && frontier.length > 0; level += 1) {
      const unread = frontier.filter((id) => !childIds.has(id))
      const found = await store.childLinksOf(unread)
      for (const id of unread) childIds.set(id, [])
      for (const link of found) {
        links.push(link)
        childIds.get(link.source_id)?.push(link.destination_id)
      }
      const next = [...new Set(frontier.flatMap((id) => childIds.get(id) ?? []))]
      const absent = next.filter((id) => !nodes.has(id))
      for (const node of await store.nodesOf(absent)) nodes.set(node.id, node)
      frontier = next.filter((id) => nodes.has(id))
    }
  }

  await readBeneath([CORPUS_ROOT_ID], 1)
  const absentRoots = viewRoots.filter((id) => !nodes.has(id))
  for (const node of await store.nodesOf(absentRoots)) nodes.set(node.id, node)
  for (const frame of frames) {
    if (frame.id === CORPUS_ROOT_ID && frame.depth <= ROOT_DEPTH) {
      // The Root frame's rows are the notes, by type (`rootChildIds`), and
      // closed: a chevron needs one child, not the list. A note's top-level
      // blocks can be most of the corpus.
      const firsts = await store.firstChildLinksOf(notes)
      links.push(...firsts)
      const absent = firsts.map((link) => link.destination_id).filter((id) => !nodes.has(id))
      for (const node of await store.nodesOf(absent)) nodes.set(node.id, node)
      continue
    }
    if (frame.id === CORPUS_ROOT_ID) {
      await readBeneath(notes, frame.depth)
      continue
    }
    if (!nodes.has(frame.id)) {
      for (const node of await store.nodesOf([frame.id])) nodes.set(node.id, node)
    }
    await readBeneath([frame.id], frame.depth + 1)
  }
  // A note's first link can be read twice: once for its chevron, once with
  // its list.
  const byKey = new Map(
    links.map((link) => [linkEntityId(link.source_id, link.destination_id, link.kind), link]),
  )
  return buildGraphSnapshot([...nodes.values()], [...byKey.values()])
}
