import { PAGE_TYPE, type GraphSnapshot } from "../data/graph"

/**
 * What is upstream of each block: the pages that reach it through child
 * links. Under the graph model a node can have several (docs/graph-storage.md,
 * "Mirroring"), so a block pasted as a link is upstream of two pages, and a
 * block that was merely duplicated is upstream of one under a fresh id. That
 * difference is invisible in the rendered text; this index is what makes it
 * visible (the developer-mode block metadata, `src/hooks/is-developer.ts`).
 */
export type UpstreamIndex = ReadonlyMap<string, readonly string[]>

export function buildUpstreamIndex(snapshot: GraphSnapshot): UpstreamIndex {
  const index = new Map<string, string[]>()
  for (const node of snapshot.nodes.values()) {
    if (node.type !== PAGE_TYPE) continue
    const seen = new Set<string>()
    const stack = [node.id]
    while (stack.length > 0) {
      const id = stack.pop() as string
      for (const link of snapshot.childLinks.get(id) ?? []) {
        const child = link.destination_id
        if (seen.has(child)) continue
        seen.add(child)
        const upstream = index.get(child)
        if (!upstream) index.set(child, [node.id])
        else if (!upstream.includes(node.id)) upstream.push(node.id)
        stack.push(child)
      }
    }
  }
  return index
}
