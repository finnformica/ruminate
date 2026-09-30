import { blockId } from "../blocks/id"
import type { NoteId } from "../schema"
import {
  NOTE_TYPE,
  childIdsOf,
  noteDoc,
  parentIdsOf,
  propsJson,
  sortKeyBetween,
  type GraphSnapshot,
} from "./graph"
import type { Op } from "./ops"

/**
 * **Boards** (docs/boards.md): a note read as a wall of pictures, with a
 * few features — a location, a fixture, a material — you can set on each
 * one from a form instead of the outline.
 *
 * Nothing here is a new kind of thing. A board is any note. Its pictures
 * are the image blocks the note reaches; the ones added from the board are
 * direct children of the page, in the order they were added. A FEATURE is a
 * direct child of the page whose text is one of the labels below, created
 * the first time a picture is given one; a VALUE is a child of that block
 * ("Mauritius" under "Location"), created the first time it is picked; and
 * setting a value on a picture is a `link` from the value block to the
 * picture — the same second parent that copy and select-mode paste give a
 * block in the editor. So the outline shows exactly what the board shows,
 * a board can be written by hand in the outline and the form picks it up,
 * and deleting a value leaves its pictures on the board, untagged.
 *
 * Every function is pure: a snapshot in, a batch of ops out, applied
 * through the one storage seam (`src/data/store.ts`) like the editor's.
 */

export interface BoardFeature {
  /** The block's text on the page, and what the form calls it. */
  label: string
  /** Whether a picture may carry several of its values at once. */
  multi: boolean
}

/** The features a board offers, in the order the form shows them. The
 * label is the identity: a block on the page with this text (trimmed,
 * case-insensitively) is the feature's block. */
export const BOARD_FEATURES: readonly BoardFeature[] = [
  { label: "Location", multi: false },
  { label: "Fixture", multi: true },
  { label: "Material", multi: true },
]

/** The type a feature block is created as, and the type a value is. */
const FEATURE_BLOCK_TYPE = "text"
const VALUE_BLOCK_TYPE = "ul"
const IMAGE_TYPE = "image"

const normalise = (text: string) => text.trim().toLocaleLowerCase()

/** Whether a block's text names this feature. */
const isFeatureText = (text: string, feature: BoardFeature) =>
  normalise(text) === normalise(feature.label)

/** Whether a note exists in the snapshot to be a board. */
export function isBoard(snapshot: GraphSnapshot, boardId: NoteId): boolean {
  return snapshot.nodes.get(boardId)?.type === NOTE_TYPE
}

/**
 * The feature's block on the page: the first direct child whose text is the
 * label, or null when no picture has been given this feature yet. Only the
 * first: a second child with the same text is ordinary content, never a
 * second feature.
 */
export function featureBlockId(
  snapshot: GraphSnapshot,
  boardId: NoteId,
  feature: BoardFeature,
): string | null {
  for (const id of childIdsOf(snapshot, boardId)) {
    const node = snapshot.nodes.get(id)
    if (node && node.type !== IMAGE_TYPE && isFeatureText(node.text, feature)) return id
  }
  return null
}

export interface BoardValue {
  id: string
  text: string
}

/** A feature as it stands on one board: its block, if any, and its values. */
export interface BoardFeatureState {
  feature: BoardFeature
  blockId: string | null
  values: BoardValue[]
}

/** The values under a feature block: its direct children, in order. A
 * picture pasted straight under the feature is a picture, not a value. */
function valuesOf(snapshot: GraphSnapshot, featureBlock: string): BoardValue[] {
  const values: BoardValue[] = []
  for (const id of childIdsOf(snapshot, featureBlock)) {
    const node = snapshot.nodes.get(id)
    if (node && node.type !== IMAGE_TYPE) values.push({ id, text: node.text })
  }
  return values
}

/** Every feature, in preset order, as it stands on the board. */
export function boardFeatures(snapshot: GraphSnapshot, boardId: NoteId): BoardFeatureState[] {
  return BOARD_FEATURES.map((feature) => {
    const block = featureBlockId(snapshot, boardId, feature)
    return { feature, blockId: block, values: block ? valuesOf(snapshot, block) : [] }
  })
}

/**
 * The board's pictures: every image block the note reaches, each once. The
 * page's own direct children lead, in their order — the order pictures were
 * added from the board — and then any picture reached only through a value
 * or deeper, in document order (one pasted under a heading, say).
 */
export function boardImageIds(snapshot: GraphSnapshot, boardId: NoteId): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (id: string) => {
    if (seen.has(id)) return
    if (snapshot.nodes.get(id)?.type !== IMAGE_TYPE) return
    seen.add(id)
    out.push(id)
  }
  for (const id of childIdsOf(snapshot, boardId)) add(id)
  const doc = noteDoc(boardId, snapshot)
  if (!doc) return out
  const path = new Set<string>()
  const walk = (ids: string[]) => {
    for (const id of ids) {
      const block = doc.blocks[id]
      if (!block || path.has(id)) continue
      add(id)
      path.add(id)
      walk(block.children)
      path.delete(id)
    }
  }
  walk(doc.rootBlockIds)
  return out
}

/** The value blocks a picture carries, among a feature's values. */
export function imageValues(
  snapshot: GraphSnapshot,
  state: BoardFeatureState,
  imageId: string,
): BoardValue[] {
  const parents = new Set(parentIdsOf(snapshot, imageId))
  return state.values.filter((value) => parents.has(value.id))
}

/**
 * The pictures carrying every one of `valueIds`: a value is carried when
 * the value block is one of the picture's parents. Tested here rather than
 * as `in:` scopes in a search, because a search tests each `in:` against
 * one occurrence's ancestry, and a picture under two values is on two
 * paths, neither of which passes both.
 */
export function carryingAll(
  snapshot: GraphSnapshot,
  imageIds: readonly string[],
  valueIds: readonly string[],
): string[] {
  if (valueIds.length === 0) return [...imageIds]
  return imageIds.filter((imageId) => {
    const parents = new Set(parentIdsOf(snapshot, imageId))
    return valueIds.every((valueId) => parents.has(valueId))
  })
}

/** The sort key that puts a new child last under `parentId`. */
function keyAtEnd(snapshot: GraphSnapshot, parentId: string): string {
  const links = snapshot.childLinks.get(parentId) ?? []
  return sortKeyBetween(links.length ? links[links.length - 1].sort_key : null, null)
}

/**
 * A picture added from the board: an image block written in the note, with
 * no picture yet (`imageUploadedOps` fills it in when the bytes land, as
 * the editor does), linked last under the page.
 */
export function addImageOps(snapshot: GraphSnapshot, boardId: NoteId, imageId: string): Op[] {
  return [
    { op: "create", id: imageId, type: IMAGE_TYPE, text: "", props: null, notesId: boardId },
    { op: "link", source: boardId, destination: imageId, sortKey: keyAtEnd(snapshot, boardId) },
  ]
}

/** The upload landed: the asset the block now shows. */
export function imageUploadedOps(
  imageId: string,
  asset: { id: string; width?: number; height?: number },
): Op[] {
  const props = {
    image: asset.id,
    ...(asset.width && asset.height ? { width: asset.width, height: asset.height } : {}),
  }
  return [{ op: "setProps", id: imageId, props: propsJson(props) }]
}

/** A picture's caption — the image block's text, what search matches. */
export function setCaptionOps(snapshot: GraphSnapshot, imageId: string, caption: string): Op[] {
  const node = snapshot.nodes.get(imageId)
  if (!node || node.text === caption) return []
  return [{ op: "setText", id: imageId, text: caption }]
}

/**
 * The key that puts a new feature block among the others at the top of the
 * page: after the last feature block, before whatever follows it, so the
 * features stay together and the pictures keep their place beneath.
 */
function featureKey(snapshot: GraphSnapshot, boardId: NoteId): string {
  const links = snapshot.childLinks.get(boardId) ?? []
  let lastFeature = -1
  links.forEach((link, index) => {
    const node = snapshot.nodes.get(link.destination_id)
    if (!node || node.type === IMAGE_TYPE) return
    if (BOARD_FEATURES.some((feature) => isFeatureText(node.text, feature))) lastFeature = index
  })
  const before = lastFeature >= 0 ? links[lastFeature].sort_key : null
  const after = links[lastFeature + 1]?.sort_key ?? null
  return sortKeyBetween(before, after)
}

/** What a value is named as: an existing value's id, or the text of one to
 * find or create. */
export type ValueRef = { id: string } | { text: string }

/**
 * Give a picture a value of a feature. Whatever is missing is created on
 * the way — the feature's block, then the value's — and the picture is
 * linked beneath the value. A single-select feature first takes back any
 * other value of its own the picture carried. Nothing to do (the picture
 * already carries exactly this) is an empty batch.
 */
export function setValueOps(
  snapshot: GraphSnapshot,
  boardId: NoteId,
  feature: BoardFeature,
  imageId: string,
  ref: ValueRef,
): Op[] {
  if (!isBoard(snapshot, boardId) || !snapshot.nodes.has(imageId)) return []
  const ops: Op[] = []

  let featureBlock = featureBlockId(snapshot, boardId, feature)
  let values: BoardValue[] = []
  if (featureBlock === null) {
    featureBlock = blockId()
    ops.push(
      {
        op: "create",
        id: featureBlock,
        type: FEATURE_BLOCK_TYPE,
        text: feature.label,
        props: null,
        notesId: boardId,
      },
      {
        op: "link",
        source: boardId,
        destination: featureBlock,
        sortKey: featureKey(snapshot, boardId),
      },
    )
  } else {
    values = valuesOf(snapshot, featureBlock)
  }

  let valueId: string
  if ("id" in ref) {
    if (!values.some((value) => value.id === ref.id)) return []
    valueId = ref.id
  } else {
    const text = ref.text.trim()
    if (text === "") return []
    const existing = values.find((value) => normalise(value.text) === normalise(text))
    if (existing) {
      valueId = existing.id
    } else {
      valueId = blockId()
      ops.push(
        { op: "create", id: valueId, type: VALUE_BLOCK_TYPE, text, props: null, notesId: boardId },
        {
          op: "link",
          source: featureBlock,
          destination: valueId,
          // A feature block made in this batch has no children yet.
          sortKey: values.length ? keyAtEnd(snapshot, featureBlock) : sortKeyBetween(null, null),
        },
      )
    }
  }

  const carried = new Set(parentIdsOf(snapshot, imageId))
  if (!feature.multi) {
    for (const value of values) {
      if (value.id !== valueId && carried.has(value.id)) {
        ops.push({ op: "unlink", source: value.id, destination: imageId })
      }
    }
  }
  if (!carried.has(valueId)) {
    // A value made in this batch has no children yet; an existing one
    // takes the picture after those it already holds.
    const existed = values.some((value) => value.id === valueId)
    ops.push({
      op: "link",
      source: valueId,
      destination: imageId,
      sortKey: existed ? keyAtEnd(snapshot, valueId) : sortKeyBetween(null, null),
    })
  }
  return ops
}

/** Take a value back off a picture. The value stays for the others. */
export function clearValueOps(snapshot: GraphSnapshot, valueId: string, imageId: string): Op[] {
  if (!parentIdsOf(snapshot, imageId).includes(valueId)) return []
  return [{ op: "unlink", source: valueId, destination: imageId }]
}

/**
 * The batch that puts `before` back after `ops` were applied to it — what
 * the board's Undo does, since a form has no editor history behind it. A
 * create is deleted, a link is unlinked (or put back at the key it had), a
 * changed text or props is set back. Null when the batch holds something
 * that cannot be undone this way (a delete: nothing restores a tombstone).
 */
export function inverseOps(ops: readonly Op[], before: GraphSnapshot): Op[] | null {
  const inverse: Op[] = []
  const created = new Set<string>()
  for (const op of ops) if (op.op === "create") created.add(op.id)
  for (const op of [...ops].reverse()) {
    switch (op.op) {
      case "create":
        inverse.push({ op: "delete", id: op.id })
        break
      case "delete":
        return null
      case "setText":
      case "setType":
      case "setProps": {
        // A node created in the same batch goes with its delete.
        if (created.has(op.id)) break
        const node = before.nodes.get(op.id)
        if (!node) break
        if (op.op === "setText") inverse.push({ op: "setText", id: op.id, text: node.text })
        else if (op.op === "setType") inverse.push({ op: "setType", id: op.id, type: node.type })
        else inverse.push({ op: "setProps", id: op.id, props: node.props })
        break
      }
      case "link": {
        if (created.has(op.source) || created.has(op.destination)) break
        const had = (before.childLinks.get(op.source) ?? []).find(
          (link) => link.destination_id === op.destination,
        )
        if (had) {
          inverse.push({
            op: "link",
            source: op.source,
            destination: op.destination,
            sortKey: had.sort_key,
          })
        } else {
          inverse.push({ op: "unlink", source: op.source, destination: op.destination })
        }
        break
      }
      case "unlink": {
        const had = (before.childLinks.get(op.source) ?? []).find(
          (link) => link.destination_id === op.destination,
        )
        if (had) {
          inverse.push({
            op: "link",
            source: op.source,
            destination: op.destination,
            sortKey: had.sort_key,
          })
        }
        break
      }
    }
  }
  return inverse
}
