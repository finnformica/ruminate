import type { NodeRow } from "../../worker/handlers/replica-payload"
import type { BlockProps } from "../blocks/types"
import { parseProps, propsJson, type GraphSnapshot } from "./graph"
import type { Op } from "./ops"

/**
 * **Pins** (docs/removing-views.md): a note or a block kept to hand in the
 * sidebar's **Pinned** list. A pin is a prop of the node, `pinned_at`, the
 * ms epoch it was pinned at — so it is an edit like any other, held per key
 * in the event log, and there is no table or entity beside the graph for
 * it. The list is the pinned nodes, oldest pin first.
 *
 * Pins replace the views table's `pinned` rows. A pin is the node's, so a
 * node in a note someone shared is not offered one: its props are the
 * owner's.
 */
export const PINNED_PROP = "pinned_at"

/** When `node` was pinned, or null when it is not. The substring test keeps
 * the scan of every node from parsing props that cannot hold a pin. */
export function pinnedAtOf(node: Pick<NodeRow, "props">): number | null {
  if (node.props === null || !node.props.includes(PINNED_PROP)) return null
  return pinnedAtOfProps(parseProps(node.props))
}

/** The same, read off a doc block's props. */
export function pinnedAtOfProps(props: BlockProps | null | undefined): number | null {
  const at = props?.[PINNED_PROP]
  return typeof at === "number" && Number.isFinite(at) ? at : null
}

/** The ids of the pinned nodes, oldest pin first (the id breaks a tie). */
export function pinnedIdsOf(graph: GraphSnapshot): string[] {
  const pinned: { id: string; at: number }[] = []
  for (const node of graph.nodes.values()) {
    if (node.deleted_at != null) continue
    const at = pinnedAtOf(node)
    if (at !== null) pinned.push({ id: node.id, at })
  }
  pinned.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return pinned.map(({ id }) => id)
}

/** The op that pins `node` at `now`, or unpins it: its props with
 * `pinned_at` set or taken out. None when it is already so. */
export function pinOps(node: Pick<NodeRow, "id" | "props">, pinned: boolean, now: number): Op[] {
  if ((pinnedAtOf(node) !== null) === pinned) return []
  const { [PINNED_PROP]: _, ...rest } = parseProps(node.props) ?? {}
  const props = pinned ? { ...rest, [PINNED_PROP]: now } : rest
  return [{ op: "setProps", id: node.id, props: propsJson(props) }]
}
