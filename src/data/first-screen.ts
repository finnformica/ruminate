import type { LinkRow, NodeRow } from "../../worker/handlers/replica-payload"
import {
  buildGraphSnapshot,
  CORPUS_ROOT_ID,
  NOTE_TYPES,
  ROOT_TYPE,
  rootChildIds,
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
 *
 * Each frame reads at most `FIRST_SCREEN_ROWS` rows, the first in display
 * order, so the top of the page is whole and a long note costs no more than
 * a short one. The rows past it are not drawn until the whole graph lands.
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

/** How many rows of a frame the first screen reads, in display order: about
 * a screen and a half of rows. The rows past it come with the whole graph. */
export const FIRST_SCREEN_ROWS = 300

/**
 * Read the first screen from the store: every note and board (the Root
 * frame's rows, the sidebar, the palette's list, and what tells a note that
 * exists from a new one), the corpus root and its order, the roots of the
 * views, and each frame's first `FIRST_SCREEN_ROWS` rows in display order,
 * to one level past its depth.
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

  const readLists = async (ids: readonly string[]) => {
    const unread = ids.filter((id) => !childIds.has(id))
    const found = await store.childLinksOf(unread)
    for (const id of unread) childIds.set(id, [])
    for (const link of found) {
      links.push(link)
      childIds.get(link.source_id)?.push(link.destination_id)
    }
  }
  const readNodes = async (ids: readonly string[]) => {
    for (const node of await store.nodesOf(ids.filter((id) => !nodes.has(id)))) {
      nodes.set(node.id, node)
    }
  }

  /** The first rows from `start` in display order, as far as the lists read
   * so far reach: a row at `maxLevel` is a closed row's child. */
  const displayOrder = (start: readonly string[], startLevel: number, maxLevel: number) => {
    const rows: { id: string; level: number }[] = []
    const path = new Set<string>()
    const visit = (id: string, level: number) => {
      if (rows.length >= FIRST_SCREEN_ROWS || path.has(id)) return
      rows.push({ id, level })
      if (level >= maxLevel) return
      path.add(id)
      for (const child of childIds.get(id) ?? []) visit(child, level + 1)
      path.delete(id)
    }
    for (const id of start) visit(id, startLevel)
    return rows
  }

  /** Read a frame's first rows: each round reads, in one batch, the lists of
   * every row in the first rows not read yet. A round adds rows only deeper
   * down, so there are at most `maxLevel - startLevel` rounds. */
  const readFrame = async (start: readonly string[], startLevel: number, maxLevel: number) => {
    for (;;) {
      const unread = displayOrder(start, startLevel, maxLevel)
        .filter((row) => row.level < maxLevel && !childIds.has(row.id))
        .map((row) => row.id)
      if (unread.length === 0) break
      await readLists(unread)
    }
    await readNodes(displayOrder(start, startLevel, maxLevel).map((row) => row.id))
  }

  await readLists([CORPUS_ROOT_ID])
  await readNodes(viewRoots)
  // The Root frame's rows: the notes in its own order (`rootChildIds`).
  const rootRows = () => rootChildIds(buildGraphSnapshot([...nodes.values()], links))
  for (const frame of frames) {
    if (frame.id === CORPUS_ROOT_ID && frame.depth <= ROOT_DEPTH) {
      // Closed note rows: a chevron needs one child, not the list. A note's
      // top-level blocks can be most of the corpus.
      const firsts = await store.firstChildLinksOf(rootRows().slice(0, FIRST_SCREEN_ROWS))
      links.push(...firsts)
      await readNodes(firsts.map((link) => link.destination_id))
      continue
    }
    if (frame.id === CORPUS_ROOT_ID) {
      await readFrame(rootRows(), 1, frame.depth + 1)
      continue
    }
    await readNodes([frame.id])
    await readFrame([frame.id], 0, frame.depth + 1)
  }
  // A note's first link can be read twice: once for its chevron, once with
  // its list.
  const byKey = new Map(
    links.map((link) => [linkEntityId(link.source_id, link.destination_id, link.kind), link]),
  )
  return buildGraphSnapshot([...nodes.values()], [...byKey.values()])
}
