import type { LinkRow, NodeRow } from "../../worker/handlers/replica-payload"
import { linkEntityId, type EntityKeys } from "./events"
import { CHILD_KIND, indexParents, type GraphSnapshot } from "./graph"

/** Sibling order: by sort key, destination id breaking a tie. */
const byOrder = (a: LinkRow, b: LinkRow) =>
  a.sort_key < b.sort_key
    ? -1
    : a.sort_key > b.sort_key
      ? 1
      : a.destination_id < b.destination_id
        ? -1
        : a.destination_id > b.destination_id
          ? 1
          : 0

/**
 * A part of the corpus read from the cache (`LazyReads`,
 * src/data/sql-lazy-reads.ts): some live nodes, some live links, and the
 * ids whose child links the fragment holds in full.
 */
export interface GraphFragment {
  nodes: readonly NodeRow[]
  links: readonly LinkRow[]
  loaded: readonly string[]
}

/** The graph with nothing in it, lazily loaded: every id is unloaded. */
export const emptyLazyGraph = (): GraphSnapshot => ({
  nodes: new Map(),
  childLinks: new Map(),
  parentLinks: new Map(),
  loaded: new Set(),
})

/**
 * Merge a fragment into a lazily loaded graph (docs/events-log-cache.md,
 * "The client"): its nodes replace the rows held; a source the fragment
 * holds in full takes the fragment's child list, any other source gains
 * the fragment's links beside the ones it has; the loaded set grows by the
 * ids held in full. A link whose end is a node the graph does not hold is
 * kept all the same: the walk skips a dangling one, and the node may come
 * with a later fragment (an upward closure names ancestors in other notes).
 */
export function mergeFragment(graph: GraphSnapshot, fragment: GraphFragment): GraphSnapshot {
  const nodes = new Map(graph.nodes)
  for (const row of fragment.nodes) nodes.set(row.id, row)
  const complete = new Set(fragment.loaded)
  // A fragment can name a link twice (a note's subtree and its upward
  // closure both cross the note's own links): once is enough.
  const unique = new Map<string, LinkRow>()
  for (const link of fragment.links) {
    if (link.kind !== CHILD_KIND) continue
    unique.set(linkEntityId(link.source_id, link.destination_id, link.kind), link)
  }
  const bySource = new Map<string, LinkRow[]>()
  for (const link of unique.values()) {
    const list = bySource.get(link.source_id)
    if (list) list.push(link)
    else bySource.set(link.source_id, [link])
  }
  const childLinks = new Map(graph.childLinks)
  for (const id of complete) if (!bySource.has(id)) childLinks.delete(id)
  for (const [source, links] of bySource) {
    const list = complete.has(source)
      ? [...links]
      : [
          ...(graph.childLinks.get(source) ?? []).filter(
            (held) => !links.some((link) => link.destination_id === held.destination_id),
          ),
          ...links,
        ]
    list.sort(byOrder)
    childLinks.set(source, list)
  }
  const loaded = new Set(graph.loaded ?? [])
  for (const id of complete) loaded.add(id)
  return { nodes, childLinks, parentLinks: indexParents(childLinks), loaded }
}

/**
 * Patch the live graph after a batch (docs/events-log-cache.md, "Each new
 * event"): replace only the entities the batch touched, and nothing is
 * rebuilt from every row.
 *
 * `rows` is what the store answered for `touched` (`NoteStore.liveEntitiesOf`):
 * the live rows of the touched blocks, and every live link among the
 * touched links or adjacent to a touched block, live by its own `deleted`
 * row. A touched block the store did not answer for is gone (tombstoned, or
 * never created); a link is kept only when it is a child link and both its
 * ends are in the patched node map — the rule `buildGraphSnapshot` applies.
 * The links re-judged are the touched ones, the ones the graph held
 * adjacent to a touched block, and the ones the store found adjacent: so a
 * block that was tombstoned takes its links out, and one that was revived
 * brings them back.
 *
 * On a lazily loaded graph (`loaded`), a touched block's child list comes
 * whole with the adjacent links, so the block is loaded after the patch;
 * and a link under a source the graph does not hold in full is not added —
 * the note it is in shows it when it is opened and loaded whole.
 */
export function patchSnapshot(
  graph: GraphSnapshot,
  touched: EntityKeys,
  rows: { nodes: readonly NodeRow[]; links: readonly LinkRow[] },
): GraphSnapshot {
  const nodes = new Map(graph.nodes)
  const fresh = new Map(rows.nodes.map((row) => [row.id, row]))
  const loaded = graph.loaded === undefined ? undefined : new Set(graph.loaded)
  for (const id of touched.blocks) {
    const row = fresh.get(id)
    if (row === undefined) {
      nodes.delete(id)
      loaded?.delete(id)
    } else {
      nodes.set(id, row)
      loaded?.add(id)
    }
  }

  const idOf = (link: LinkRow) => linkEntityId(link.source_id, link.destination_id, link.kind)
  const judged = new Set<string>(touched.links)
  for (const id of touched.blocks) {
    for (const link of graph.childLinks.get(id) ?? []) judged.add(idOf(link))
    for (const link of graph.parentLinks.get(id) ?? []) judged.add(idOf(link))
  }
  const kept = new Map<string, LinkRow>()
  for (const link of rows.links) {
    judged.add(idOf(link))
    if (link.kind !== CHILD_KIND) continue
    if (!nodes.has(link.source_id) || !nodes.has(link.destination_id)) continue
    if (loaded !== undefined && !loaded.has(link.source_id)) continue
    kept.set(idOf(link), link)
  }

  // The child lists of every source a judged link names, rebuilt: the
  // graph's links not judged, plus the kept fresh ones, in sibling order.
  const sources = new Set<string>()
  for (const id of judged) sources.add(id.split("|")[0])
  const childLinks = new Map(graph.childLinks)
  for (const source of sources) {
    const list = (graph.childLinks.get(source) ?? []).filter((link) => !judged.has(idOf(link)))
    for (const link of kept.values()) if (link.source_id === source) list.push(link)
    list.sort(byOrder)
    if (list.length === 0) childLinks.delete(source)
    else childLinks.set(source, list)
  }
  const parentLinks = indexParents(childLinks)
  return loaded === undefined
    ? { nodes, childLinks, parentLinks }
    : { nodes, childLinks, parentLinks, loaded }
}
