import { blockId } from "../blocks/id"
import type { NoteId } from "../schema"
import { BOARD_PROP } from "../utils/board-prop"
import {
  NOTE_TYPE,
  childIdsOf,
  noteDoc,
  parentIdsOf,
  parseProps,
  propsJson,
  sortKeyBetween,
  type GraphSnapshot,
} from "./graph"
import { unassignedIds } from "./basket"
import type { TagFeature, TagSuggestion } from "./auto-tag"
import { applyOps, type Op } from "./ops"

/**
 * **Boards** (docs/boards.md): a note read as a wall of pictures, with a
 * few features — a location, a fixture, a material — you can set on each
 * one from a form instead of the outline.
 *
 * A board is a note whose page carries `board: true` (`BOARD_PROP`):
 * made by **New board**, drawn with its own icon, opened on its own page.
 * Beneath that one property nothing here is a new kind of thing. Its pictures
 * are the image blocks written in the note: the ones its outline reaches,
 * and the ones nothing reaches yet, which sit in the note's Unassigned
 * basket (`basket.ts`) as any such block does. A picture added from the
 * board is written in the note with no parent, so it starts in the basket.
 * A FEATURE is a direct child of the page whose text is one of the labels
 * below, created the first time a picture is given one; a VALUE is a child
 * of that block ("Mauritius" under "Location"), created the first time it
 * is picked; and setting a value on a picture is a `link` from the value
 * block to the picture — the same parent that select-mode paste gives a
 * block in the editor, and what takes the picture out of the basket.
 * Clearing its last value unlinks it, and the basket has it again. So the
 * outline shows exactly what the board shows, a board can be written by
 * hand in the outline and the form picks it up, and nothing here is a rule
 * of its own: it is the editor's basket, read and written the editor's way.
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

/** Whether the note is a board: a note whose page carries `board: true`
 * (`BOARD_PROP`). The board page refuses any other note, and the writes
 * here write to nothing else. */
export function isBoard(snapshot: GraphSnapshot, boardId: NoteId): boolean {
  const node = snapshot.nodes.get(boardId)
  if (!node || node.type !== NOTE_TYPE) return false
  return parseProps(node.props)?.[BOARD_PROP] === true
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
 * The board's pictures, each once: every image block the outline reaches,
 * in document order, then the ones in the note's Unassigned basket —
 * written in the note, reached by nothing, so not yet given a value — most
 * recently changed first, as the basket lists them beneath the outline.
 */
export function boardImageIds(snapshot: GraphSnapshot, boardId: NoteId): string[] {
  const outline = outlineImageIds(snapshot, boardId)
  const seen = new Set(outline)
  return [...outline, ...unassignedImageIds(snapshot, boardId).filter((id) => !seen.has(id))]
}

/** The image blocks the note's outline reaches, in document order, once
 * each — the rows a filter and a sort on the note can narrow. */
export function outlineImageIds(snapshot: GraphSnapshot, boardId: NoteId): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const doc = noteDoc(boardId, snapshot)
  if (!doc) return out
  const path = new Set<string>()
  const walk = (ids: string[]) => {
    for (const id of ids) {
      const block = doc.blocks[id]
      if (!block || path.has(id)) continue
      if (!seen.has(id) && snapshot.nodes.get(id)?.type === IMAGE_TYPE) {
        seen.add(id)
        out.push(id)
      }
      path.add(id)
      walk(block.children)
      path.delete(id)
    }
  }
  walk(doc.rootBlockIds)
  return out
}

/** The pictures in the note's Unassigned basket, most recently changed
 * first: image blocks written in the note that no note reaches. */
export function unassignedImageIds(snapshot: GraphSnapshot, boardId: NoteId): string[] {
  const ids: string[] = []
  for (const id of unassignedIds(snapshot)) {
    const node = snapshot.nodes.get(id)
    if (node && node.type === IMAGE_TYPE && node.notes_id === boardId) ids.push(id)
  }
  const stamp = (id: string) => snapshot.nodes.get(id)?.updated_at ?? 0
  return ids.sort((a, b) => stamp(b) - stamp(a) || (a < b ? -1 : 1))
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

/** The sort key that puts a new child last under `parentId`. */
function keyAtEnd(snapshot: GraphSnapshot, parentId: string): string {
  const links = snapshot.childLinks.get(parentId) ?? []
  return sortKeyBetween(links.length ? links[links.length - 1].sort_key : null, null)
}

/**
 * A picture added from the board: an image block written in the note, with
 * no picture yet (`imageUploadedOps` fills it in when the bytes land, as
 * the editor does) and no parent, so it sits in the note's Unassigned
 * basket until a value takes it. Nothing when there is no such note to
 * write it in.
 */
export function addImageOps(snapshot: GraphSnapshot, boardId: NoteId, imageId: string): Op[] {
  if (!isBoard(snapshot, boardId)) return []
  return [{ op: "create", id: imageId, type: IMAGE_TYPE, text: "", props: null, notesId: boardId }]
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

/** The board's features as the tagging route is told them (docs/boards.md,
 * "Tagging with Claude"): each label, whether it takes several values, and
 * the values in use. */
export function tagFeaturesOf(snapshot: GraphSnapshot, boardId: NoteId): TagFeature[] {
  return boardFeatures(snapshot, boardId).map((state) => ({
    label: state.feature.label,
    multi: state.feature.multi,
    values: state.values.map((value) => value.text.trim()).filter((text) => text !== ""),
  }))
}

/**
 * A suggestion from Claude (`TagSuggestion`, src/data/auto-tag.ts) as the
 * writes it amounts to: one batch, undoable as one. It FILLS IN, never
 * overrides — a caption is written only where the picture has none, a
 * single-value feature only where the picture carries none of its values,
 * and a multi-value feature's values are added to those carried. Each
 * value goes through `setValueOps` with the text, so an existing value is
 * reused and a new one created, the batch built up against the snapshot as
 * each write would leave it. An empty batch is a suggestion with nothing
 * to add.
 */
export function suggestionOps(
  snapshot: GraphSnapshot,
  boardId: NoteId,
  imageId: string,
  suggestion: TagSuggestion,
  now: number,
): Op[] {
  const ops: Op[] = []
  if (!isBoard(snapshot, boardId)) return ops
  let current = snapshot
  const take = (batch: Op[]) => {
    if (batch.length === 0) return
    ops.push(...batch)
    current = applyOps(current, batch, now)
  }

  const node = current.nodes.get(imageId)
  if (!node) return ops
  const caption = suggestion.caption.trim()
  if (caption !== "" && node.text.trim() === "") take(setCaptionOps(current, imageId, caption))

  for (const feature of BOARD_FEATURES) {
    const answer = suggestion.features.find((entry) => isFeatureText(entry.label, feature))
    if (!answer) continue
    const state = boardFeatures(current, boardId).find((entry) => entry.feature === feature)
    const carried = state ? imageValues(current, state, imageId) : []
    if (!feature.multi && carried.length > 0) continue
    const carriedTexts = new Set(carried.map((value) => normalise(value.text)))
    for (const text of feature.multi ? answer.values : answer.values.slice(0, 1)) {
      if (carriedTexts.has(normalise(text))) continue
      take(setValueOps(current, boardId, feature, imageId, { text }))
    }
  }
  return ops
}

/**
 * Take every value back off a picture, all features at once — the
 * inspector's **Reset**, one batch with one Undo. The values stay for the
 * other pictures; the caption is left as it is; a picture left with no
 * parent is back in the basket. Nothing when it carries no value.
 */
export function resetValuesOps(snapshot: GraphSnapshot, boardId: NoteId, imageId: string): Op[] {
  if (!isBoard(snapshot, boardId)) return []
  const ops: Op[] = []
  for (const state of boardFeatures(snapshot, boardId)) {
    for (const value of imageValues(snapshot, state, imageId)) {
      ops.push(...clearValueOps(snapshot, value.id, imageId))
    }
  }
  return ops
}

/** Take a value back off a picture. The value stays for the others; a
 * picture left with no parent is back in the basket. */
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
