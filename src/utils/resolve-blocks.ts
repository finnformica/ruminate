import { serialize } from "../blocks/serialize"
import { docFromGraph, type GraphSnapshot } from "../data/graph"

/**
 * Resolve block ids to their LIVE subtree markdown from the graph — the
 * lookup behind "paste as link" (docs/graph-storage.md). Paste must insert
 * the node's current content, never the clipboard bytes: a stale clipboard
 * must not LWW-clobber the live node on the next write.
 *
 * Each resolved id maps to block-format markdown of its whole subtree —
 * content lines with two-space nesting plus `id::` lines, exactly what
 * `serialize` emits — so `parse` rebuilds it with ids intact. An id the graph
 * no longer holds maps to null (deleted since copy; the caller falls back to
 * the clipboard-embedded content).
 */
export function resolveBlockSubtrees(
  snapshot: GraphSnapshot,
  ids: string[],
): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const id of ids) {
    out[id] = snapshot.nodes.has(id) ? serialize(docFromGraph([id], snapshot)) : null
  }
  return out
}
