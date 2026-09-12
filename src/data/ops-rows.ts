import {
  emptyGraphDiff,
  type GraphDiff,
  type LinkRow,
  type NodeRow,
} from "../../worker/handlers/replica-payload"
import { CHILD_KIND, type GraphSnapshot } from "./graph"
import type { Op } from "./ops"

/**
 * Ops → rows, without a database.
 *
 * `applyOps` (ops.ts) says what a batch means to the *snapshot* — what the
 * screen shows next. This says what the same batch means to *storage*: the
 * node and link rows whose values change, as a `GraphDiff`, which is exactly
 * the shape `planReplicaPut` turns into SQL.
 *
 * The browser has had this step all along, inlined in its store
 * (`planOp`/`emitWrite`, sql-note-store.ts) where it emits single-tenant
 * statements directly. The MCP server needs the same translation on the
 * server side, against the column-tenanted replica, so the rule is written
 * once here as a pure function over a `GraphSnapshot` and the two callers
 * are pinned against each other by `ops-rows.test.ts`.
 *
 * The invariants it shares with the store:
 *
 * - **Every change is a whole-row upsert**, tombstones included. A delete is
 *   a row carrying `deleted_at`, which is what makes it replicate.
 * - **`now` is captured once per batch**, so every row one delete retires
 *   shares a `deleted_at` and "revive the rows stamped at T" stays a
 *   well-defined restore.
 * - **Deletes never cascade.** Tombstoning a node deliberately leaves its
 *   link rows alone: a link into a deleted node is where a restore would put
 *   it back, and the walk drops it at read time (`buildGraphSnapshot`).
 * - **A `set*` on a node the graph no longer holds is dropped**, not
 *   resurrected — the node was deleted underneath this batch.
 * - **Later ops see earlier ones.** The working copy is mutated as the batch
 *   is walked, so `create` then `setText` emits one row, not two.
 */

/** Link rows keyed like the store's working copy: source, dest, kind. */
const linkKey = (source: string, destination: string, kind: string) =>
  `${source}\x1f${destination}\x1f${kind}`

/** The live working copy a batch plans against: the snapshot, flattened. */
function workingCopy(snapshot: GraphSnapshot): {
  nodes: Map<string, NodeRow>
  links: Map<string, LinkRow>
} {
  const nodes = new Map(snapshot.nodes)
  const links = new Map<string, LinkRow>()
  for (const list of snapshot.childLinks.values()) {
    for (const link of list) {
      links.set(linkKey(link.source_id, link.destination_id, link.kind), link)
    }
  }
  return { nodes, links }
}

/**
 * The rows a batch of ops writes. Pure: `snapshot` is not mutated, and the
 * result is the net change — a node touched twice appears once, holding its
 * final value.
 */
export function opsToRows(
  snapshot: GraphSnapshot,
  ops: readonly Op[],
  now: number = Date.now(),
): GraphDiff {
  const mem = workingCopy(snapshot)
  const nodeWrites = new Map<string, NodeRow>()
  const linkWrites = new Map<string, LinkRow>()

  const upsertNode = (node: NodeRow) => {
    const live = { ...node }
    delete live.deleted_at
    // `seq` is the replica's to assign (migrations/0005): a row pushed in
    // never carries one, so a row read out of the snapshot must shed it.
    delete live.seq
    mem.nodes.set(live.id, live)
    nodeWrites.set(live.id, live)
  }
  const upsertLink = (link: LinkRow) => {
    const live = { ...link }
    delete live.deleted_at
    delete live.seq
    const key = linkKey(live.source_id, live.destination_id, live.kind)
    mem.links.set(key, live)
    linkWrites.set(key, live)
  }

  for (const op of ops) {
    switch (op.op) {
      case "create":
        upsertNode({
          id: op.id,
          type: op.type,
          text: op.text,
          props: op.props,
          updated_at: now,
          ...(op.notesId ? { notes_id: op.notesId } : {}),
        })
        break
      case "setText":
      case "setType":
      case "setProps": {
        const node = mem.nodes.get(op.id)
        if (!node) break
        const next: NodeRow = { ...node, updated_at: now }
        if (op.op === "setText") next.text = op.text
        else if (op.op === "setType") next.type = op.type
        else next.props = op.props
        upsertNode(next)
        break
      }
      case "link":
        upsertLink({
          source_id: op.source,
          destination_id: op.destination,
          kind: CHILD_KIND,
          sort_key: op.sortKey,
          updated_at: now,
        })
        break
      case "unlink": {
        const key = linkKey(op.source, op.destination, CHILD_KIND)
        const link = mem.links.get(key)
        if (!link) break
        mem.links.delete(key)
        linkWrites.set(key, { ...link, updated_at: now, deleted_at: now, seq: undefined })
        break
      }
      case "delete": {
        const node = mem.nodes.get(op.id)
        if (!node) break
        // Deliberately NOT cascading to link rows — see the module header.
        mem.nodes.delete(op.id)
        nodeWrites.set(op.id, { ...node, updated_at: now, deleted_at: now, seq: undefined })
        break
      }
    }
  }

  // `seq: undefined` above keeps the tombstone branches readable; strip the
  // keys so the rows serialize exactly like the ones the client pushes.
  const strip = <T extends { seq?: number }>(row: T): T => {
    if (row.seq === undefined) delete row.seq
    return row
  }

  return {
    ...emptyGraphDiff(),
    nodes: [...nodeWrites.values()].map(strip),
    links: [...linkWrites.values()].map(strip),
  }
}
