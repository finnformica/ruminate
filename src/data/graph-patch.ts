import type { LinkRow, NodeRow } from "../../worker/handlers/replica-payload"
import { linkEntityId, type EntityKeys } from "./events"
import { byParent, bySibling, CHILD_KIND, type GraphSnapshot } from "./graph"
import type { KeyEvent } from "./key-events"
import type { NoteStore } from "./note-store"

/** The entities a batch of events names, by table. */
export function keysOfEvents(events: readonly KeyEvent[]): EntityKeys {
  const keys = { blocks: new Set<string>(), links: new Set<string>(), views: new Set<string>() }
  for (const event of events) {
    const table =
      event.entity === "block" ? keys.blocks : event.entity === "link" ? keys.links : keys.views
    table.add(event.entity_id)
  }
  return keys
}

/**
 * The graph after a pulled page, read from the rows the page names and not
 * from the whole cache (docs/event-sourcing.md, "The boot read"): each named
 * node and link as the cache now holds it, and the links into and out of
 * each named node, so a delete or a revival of a node takes its links with
 * it. Only the lists those links are in are sorted again; every other row
 * and list keeps its object, so the notes and the block index build again
 * only what the page changed. The result equals `getGraph` of the cache when
 * `graph` equalled it before the page.
 */
export async function patchGraph(
  store: Pick<NoteStore, "getLiveRows" | "childLinksOf" | "parentLinksOf">,
  graph: GraphSnapshot,
  keys: EntityKeys,
): Promise<GraphSnapshot> {
  const named = [...keys.blocks]
  const live = await store.getLiveRows({ ...keys, views: new Set() })
  const children = await store.childLinksOf(named)
  const parents = await store.parentLinksOf(named)

  const nodes = new Map<string, NodeRow>(graph.nodes)
  for (const id of named) nodes.delete(id)
  for (const node of live.nodes) nodes.set(node.id, node)

  // Out: every link the page names, and every link at a named node. In:
  // what the cache holds of them now.
  const out = new Set(keys.links)
  for (const id of named) {
    for (const link of graph.childLinks.get(id) ?? []) out.add(keyOf(link))
    for (const link of graph.parentLinks.get(id) ?? []) out.add(keyOf(link))
  }
  const added = new Map<string, LinkRow>()
  for (const link of [...live.links, ...children, ...parents]) {
    if (link.kind === CHILD_KIND) added.set(keyOf(link), link)
  }
  const sources = new Set<string>()
  const destinations = new Set<string>()
  for (const key of [...out, ...added.keys()]) {
    const [source, destination] = key.split("|")
    sources.add(source)
    destinations.add(destination)
  }
  const kept = (link: LinkRow) => !out.has(keyOf(link)) && !added.has(keyOf(link))

  const childLinks = new Map(graph.childLinks)
  const parentLinks = new Map(graph.parentLinks)
  const write = (index: Map<string, LinkRow[]>, id: string, list: LinkRow[]) => {
    if (list.length > 0) index.set(id, list)
    else index.delete(id)
  }
  const bySource = groupBy(added.values(), "source_id")
  const byDestination = groupBy(added.values(), "destination_id")
  for (const id of sources) {
    const list = (graph.childLinks.get(id) ?? []).filter(kept)
    write(childLinks, id, [...list, ...(bySource.get(id) ?? [])].sort(bySibling))
  }
  for (const id of destinations) {
    const list = (graph.parentLinks.get(id) ?? []).filter(kept)
    write(parentLinks, id, [...list, ...(byDestination.get(id) ?? [])].sort(byParent))
  }
  return { nodes, childLinks, parentLinks }
}

const keyOf = (link: LinkRow) => linkEntityId(link.source_id, link.destination_id, link.kind)

function groupBy(links: Iterable<LinkRow>, end: "source_id" | "destination_id") {
  const groups = new Map<string, LinkRow[]>()
  for (const link of links) {
    const group = groups.get(link[end])
    if (group) group.push(link)
    else groups.set(link[end], [link])
  }
  return groups
}
