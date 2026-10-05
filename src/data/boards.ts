import { blockId } from "../blocks/id"
import {
  hostOf,
  hrefOf,
  isWebUrl,
  linkPropsOf,
  withLinkPreview,
  type LinkPreview,
  type LinkProps,
} from "../blocks/link"
import type { BlockProps } from "../blocks/types"
import type { NoteId } from "../schema"
import { BOARD_PROP, FEATURE_PROP } from "../utils/board-prop"
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
import { applyOps, deleteBlockOps, type Op } from "./ops"

/**
 * **Boards** (docs/boards.md): a note read as a wall of pictures, with a
 * few features — a location, an object, a material, a link to where it
 * came from — you can set on each one from a form instead of the outline.
 *
 * A board is a note whose page carries `board: true` (`BOARD_PROP`):
 * made by **New board**, drawn with its own icon, opened on its own page.
 * Beneath that one property nothing here is a new kind of thing. Its pictures
 * are the image blocks written in the note: the ones its outline reaches,
 * and the ones nothing reaches yet, which sit in the note's Unassigned
 * basket (`basket.ts`) as any such block does. A picture added from the
 * board is written in the note with no parent, so it starts in the basket.
 * A FEATURE is a direct child of the page whose props carry `feature`
 * (`FEATURE_PROP`: its type, whether it takes several values, and what it
 * means to the model) and whose text is its label — the block is the
 * feature's identity, so renaming it keeps it; a VALUE is a child of that
 * block ("Mauritius" under "Location"), created the first time it is
 * picked; and setting a value on a picture is a `link` from the value
 * block to the picture — the same parent that select-mode paste gives a
 * block in the editor, and what takes the picture out of the basket.
 * Clearing its last value unlinks it, and the basket has it again. A LINK
 * feature's values are link blocks rather than bullets (docs/links.md):
 * the page a picture came from, as its card, with the pictures from that
 * page beneath it; nothing else about it differs. A board made before
 * features were blocks has its features by name alone — Location, Object,
 * Material, Link — and those are read as the defaults they were until the
 * Features editor first touches them. So the outline shows exactly what
 * the board shows, a board can be written by hand in the outline and the
 * form picks it up, and nothing here is a rule of its own: it is the
 * editor's basket, read and written the editor's way.
 *
 * Every function is pure: a snapshot in, a batch of ops out, applied
 * through the one storage seam (`src/data/store.ts`) like the editor's.
 */

/**
 * What a feature's values are: a NAME typed in (`text`), a PLACE — a name
 * too, but the one the location hint is for when a picture carries where
 * it was taken (docs/boards.md, "Tagging with Claude") — or a web ADDRESS
 * (`link`), kept as a link block and drawn as its card, which the model is
 * never asked about.
 */
export type FeatureType = "text" | "link" | "place"

/** What the `feature` prop on a block carries. */
export interface FeatureSpec {
  type: FeatureType
  /** Whether a picture may carry several of its values at once. */
  multi: boolean
  /** What the feature is, as the model is told it; left out when nothing
   * has been said. */
  meaning?: string
}

/** A feature as the board reads it off its block. */
export interface BoardFeature extends FeatureSpec {
  /** The feature's block: its identity, so a rename keeps it. */
  id: string
  /** The block's text, and what the form calls it. */
  label: string
  meaning: string
}

/**
 * The features a new board starts with, in the order the form shows them
 * — written onto the page as blocks by **New board** and **Make this a
 * board** (`defaultFeatureOps`), and the names a board from before
 * features were blocks is read by (`LEGACY_FEATURES`). The one place the
 * defaults live.
 */
export const DEFAULT_FEATURES: readonly { label: string; spec: FeatureSpec }[] = [
  {
    label: "Location",
    spec: {
      type: "place",
      multi: false,
      meaning: "where the picture was taken, named as a person would say it",
    },
  },
  {
    label: "Object",
    spec: {
      type: "text",
      multi: true,
      meaning:
        "the thing the picture is of, such as furniture, lighting, cutlery, plants or decoration",
    },
  },
  { label: "Material", spec: { type: "text", multi: true, meaning: "what that thing is made of" } },
]

/** The names a board made before features were blocks has its features
 * by: the defaults, and the Link feature those boards offered. A direct
 * child of the page so named, with no `feature` prop, is read as that
 * feature until the Features editor stamps the prop on it. */
const LEGACY_FEATURES: readonly { label: string; spec: FeatureSpec }[] = [
  ...DEFAULT_FEATURES,
  { label: "Link", spec: { type: "link", multi: true } },
]

/** What a feature added from the editor is called until it is renamed. */
const NEW_FEATURE_LABEL = "New feature"

/** The type a feature block is created as, and the types a value is: a
 * bullet for a name, a link block for an address. */
const FEATURE_BLOCK_TYPE = "ul"
const VALUE_BLOCK_TYPE = "ul"
const LINK_BLOCK_TYPE = "link"
const IMAGE_TYPE = "image"

const normalise = (text: string) => text.trim().toLocaleLowerCase()

/** Whether two labels name one feature, trimmed and whatever their case:
 * how a board from before features were blocks is read, and how the
 * model's answer is matched to the features it was asked about. */
const sameLabel = (a: string, b: string) => normalise(a) === normalise(b)

/** Whether a feature's values are link blocks. */
export const isLinkType = (type: FeatureType): boolean => type === "link"

/** Whether the note is a board: a note whose page carries `board: true`
 * (`BOARD_PROP`). The board page refuses any other note, and the writes
 * here write to nothing else. */
export function isBoard(snapshot: GraphSnapshot, boardId: NoteId): boolean {
  const node = snapshot.nodes.get(boardId)
  if (!node || node.type !== NOTE_TYPE) return false
  return parseProps(node.props)?.[BOARD_PROP] === true
}

/**
 * The feature a block's props declare, or null when they declare none.
 * Read leniently: a `feature` that is an object is a feature, with a type
 * it does not name read as `text`, `multi` true only when it says so, and
 * a meaning only when it is a non-empty string — a hand-written prop in
 * the outline is still a feature rather than content.
 */
export function featureSpecOf(props: BlockProps | null): FeatureSpec | null {
  const raw = props?.[FEATURE_PROP]
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null
  const { type, multi, meaning } = raw as Record<string, unknown>
  const kind: FeatureType = type === "link" || type === "place" ? type : "text"
  const said = typeof meaning === "string" ? meaning.trim() : ""
  return { type: kind, multi: multi === true, ...(said !== "" ? { meaning: said } : {}) }
}

/** The block's props with the feature prop written: the spec as it is,
 * the meaning left out when empty, the rest of the props kept. */
function withFeatureSpec(props: BlockProps | null, spec: FeatureSpec): BlockProps {
  const meaning = spec.meaning?.trim() ?? ""
  return {
    ...(props ?? {}),
    [FEATURE_PROP]: {
      type: spec.type,
      multi: spec.multi,
      ...(meaning !== "" ? { meaning } : {}),
    },
  }
}

export interface BoardValue {
  id: string
  /** The name — or, for a link, its title, else its host. */
  text: string
  /** The address and the page's preview, for a link feature's value. */
  link?: LinkProps
}

/** A feature as it stands on one board: its block, and its values. */
export interface BoardFeatureState {
  feature: BoardFeature
  values: BoardValue[]
}

/** The address and preview a link block carries, or null for any other
 * block, or a link block with no address. */
function linkOf(node: { type: string; props: string | null }): LinkProps | null {
  if (node.type !== LINK_BLOCK_TYPE) return null
  const link = linkPropsOf({ props: parseProps(node.props) })
  return link.url === "" ? null : link
}

/** The values under a feature block: its direct children, in order. A
 * picture pasted straight under the feature is a picture, not a value; and
 * under a link feature only a link block is a value — a line typed there
 * by hand is content — shown by its title, else by its host. */
function valuesOf(snapshot: GraphSnapshot, feature: BoardFeature): BoardValue[] {
  const values: BoardValue[] = []
  for (const id of childIdsOf(snapshot, feature.id)) {
    const node = snapshot.nodes.get(id)
    if (!node || node.type === IMAGE_TYPE) continue
    if (isLinkType(feature.type)) {
      const link = linkOf(node)
      if (link !== null) values.push({ id, text: node.text.trim() || hostOf(link.url), link })
    } else {
      values.push({ id, text: node.text })
    }
  }
  return values
}

/**
 * The board's features, in the order their blocks stand on the page: every
 * direct child of the page whose props carry `feature`, and — for a board
 * from before features were blocks — the first direct child named as one
 * of the features those boards had (trimmed, whatever its case, whatever
 * its type), read as that feature with no prop written. A second child so
 * named, a picture, and any other child are content.
 */
export function boardFeatures(snapshot: GraphSnapshot, boardId: NoteId): BoardFeatureState[] {
  const states: BoardFeatureState[] = []
  const legacySeen = new Set<string>()
  for (const id of childIdsOf(snapshot, boardId)) {
    const node = snapshot.nodes.get(id)
    if (!node || node.type === IMAGE_TYPE) continue
    const spec = featureSpecOf(parseProps(node.props))
    let feature: BoardFeature | null = null
    if (spec) {
      feature = { id, label: node.text, ...spec, meaning: spec.meaning ?? "" }
    } else {
      const legacy = LEGACY_FEATURES.find((entry) => sameLabel(entry.label, node.text))
      if (legacy && !legacySeen.has(normalise(legacy.label))) {
        legacySeen.add(normalise(legacy.label))
        feature = { id, label: node.text, ...legacy.spec, meaning: legacy.spec.meaning ?? "" }
      }
    }
    if (feature) states.push({ feature, values: valuesOf(snapshot, feature) })
  }
  return states
}

/** One feature of the board, by its block, or null when it is not one. */
export function boardFeature(
  snapshot: GraphSnapshot,
  boardId: NoteId,
  featureId: string,
): BoardFeatureState | null {
  return boardFeatures(snapshot, boardId).find((state) => state.feature.id === featureId) ?? null
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

/** Where a picture was taken, as its block carries it: `lat`/`lon`. */
export interface ImageLocation {
  lat: number
  lon: number
}

/** The upload landed: the asset the block now shows — with its size and
 * its likeness, as the editor writes them — and where it was taken when
 * that was known by then. */
export function imageUploadedOps(
  imageId: string,
  asset: { id: string; width?: number; height?: number; thumbhash?: string },
  location?: ImageLocation | null,
): Op[] {
  const props = {
    image: asset.id,
    ...(asset.width && asset.height ? { width: asset.width, height: asset.height } : {}),
    ...(asset.thumbhash ? { thumbhash: asset.thumbhash } : {}),
    ...(location ? { lat: location.lat, lon: location.lon } : {}),
  }
  return [{ op: "setProps", id: imageId, props: propsJson(props) }]
}

/**
 * Where a picture was taken, learnt after its row was written (the
 * device's position answering behind the upload): added to the props the
 * block has, the rest kept. Nothing for a block that is gone.
 */
export function imageLocationOps(
  snapshot: GraphSnapshot,
  imageId: string,
  location: ImageLocation,
): Op[] {
  const node = snapshot.nodes.get(imageId)
  if (!node || node.deleted_at) return []
  const props = { ...(parseProps(node.props) ?? {}), lat: location.lat, lon: location.lon }
  return [{ op: "setProps", id: imageId, props: propsJson(props) }]
}

/** Where a picture was taken, off its block, or null. */
export function imageLocationOf(snapshot: GraphSnapshot, imageId: string): ImageLocation | null {
  const props = parseProps(snapshot.nodes.get(imageId)?.props ?? null)
  const lat = props?.lat
  const lon = props?.lon
  if (typeof lat !== "number" || typeof lon !== "number") return null
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  return { lat, lon }
}

/** A picture's caption — the image block's text, what search matches. */
export function setCaptionOps(snapshot: GraphSnapshot, imageId: string, caption: string): Op[] {
  const node = snapshot.nodes.get(imageId)
  if (!node || node.text === caption) return []
  return [{ op: "setText", id: imageId, text: caption }]
}

/**
 * Keys that put `count` new feature blocks among the others at the top of
 * the page: after the last feature block, before whatever follows it, so
 * the features stay together and the pictures keep their place beneath.
 */
function featureKeys(snapshot: GraphSnapshot, boardId: NoteId, count: number): string[] {
  const links = snapshot.childLinks.get(boardId) ?? []
  const features = new Set(boardFeatures(snapshot, boardId).map((state) => state.feature.id))
  let lastFeature = -1
  links.forEach((link, index) => {
    if (features.has(link.destination_id)) lastFeature = index
  })
  let before = lastFeature >= 0 ? links[lastFeature].sort_key : null
  const after = links[lastFeature + 1]?.sort_key ?? null
  const keys: string[] = []
  for (let i = 0; i < count; i += 1) {
    before = sortKeyBetween(before, after)
    keys.push(before)
  }
  return keys
}

/** The block a feature is made as: a bullet carrying the prop, named by
 * its label, written in the note. */
function featureBlockOp(boardId: NoteId, id: string, label: string, spec: FeatureSpec): Op {
  return {
    op: "create",
    id,
    type: FEATURE_BLOCK_TYPE,
    text: label,
    props: propsJson(withFeatureSpec(null, spec)),
    notesId: boardId,
  }
}

/**
 * The default features written onto a board as it is made — **New board**,
 * **Make this a board** — each a block with its prop at the top of the
 * page, in the defaults' order. A default the board already has by label
 * (a note made a board with a `Location` block written by hand, or made
 * one before) is left as it is. Nothing for a note that is not a board.
 */
export function defaultFeatureOps(snapshot: GraphSnapshot, boardId: NoteId): Op[] {
  if (!isBoard(snapshot, boardId)) return []
  const had = boardFeatures(snapshot, boardId).map((state) => state.feature.label)
  const missing = DEFAULT_FEATURES.filter(
    (entry) => !had.some((label) => sameLabel(label, entry.label)),
  )
  const keys = featureKeys(snapshot, boardId, missing.length)
  return missing.flatMap((entry, index) => {
    const id = blockId()
    return [
      featureBlockOp(boardId, id, entry.label, entry.spec),
      { op: "link", source: boardId, destination: id, sortKey: keys[index] },
    ]
  })
}

/**
 * A feature added from the Features editor: a text feature, one value at
 * a time, named "New feature" until it is renamed, after the board's
 * other features. `featureId` is the caller's, so the editor can put the
 * focus on the new row.
 */
export function addFeatureOps(snapshot: GraphSnapshot, boardId: NoteId, featureId: string): Op[] {
  if (!isBoard(snapshot, boardId) || snapshot.nodes.has(featureId)) return []
  const [key] = featureKeys(snapshot, boardId, 1)
  return [
    featureBlockOp(boardId, featureId, NEW_FEATURE_LABEL, { type: "text", multi: false }),
    { op: "link", source: boardId, destination: featureId, sortKey: key },
  ]
}

/** What the Features editor may change on a feature. */
export type FeaturePatch = Partial<Pick<BoardFeature, "label" | "type" | "multi" | "meaning">>

/**
 * A feature changed from the Features editor: its label is the block's
 * text, the rest its prop — written whole, so the first change to a
 * feature read by its name alone stamps the prop on it. A change of type
 * between a name and a link is refused while the feature has values, since
 * the value blocks it has are of the other kind: the type stays, and the
 * rest of the patch goes through. Nothing when nothing would change.
 */
export function updateFeatureOps(
  snapshot: GraphSnapshot,
  boardId: NoteId,
  featureId: string,
  patch: FeaturePatch,
): Op[] {
  const state = boardFeature(snapshot, boardId, featureId)
  const node = snapshot.nodes.get(featureId)
  if (!state || !node) return []
  const { feature } = state
  const ops: Op[] = []
  const label = patch.label?.trim()
  if (label !== undefined && label !== "" && label !== node.text) {
    ops.push({ op: "setText", id: featureId, text: label })
  }
  let type = patch.type ?? feature.type
  if (isLinkType(type) !== isLinkType(feature.type) && state.values.length > 0) type = feature.type
  const spec: FeatureSpec = {
    type,
    multi: patch.multi ?? feature.multi,
    meaning: (patch.meaning ?? feature.meaning).trim(),
  }
  const props = parseProps(node.props)
  const next = propsJson(withFeatureSpec(props, spec))
  if (next !== node.props) ops.push({ op: "setProps", id: featureId, props: next })
  return ops
}

/**
 * A feature moved one place among the board's features: its block relinked
 * under the page before the feature above it, or after the one below —
 * whatever other content stands between them is passed over. Nothing at
 * the top going up, or at the foot going down.
 */
export function moveFeatureOps(
  snapshot: GraphSnapshot,
  boardId: NoteId,
  featureId: string,
  direction: "up" | "down",
): Op[] {
  const links = snapshot.childLinks.get(boardId) ?? []
  const features = new Set(boardFeatures(snapshot, boardId).map((state) => state.feature.id))
  if (!features.has(featureId)) return []
  const at = links.findIndex((link) => link.destination_id === featureId)
  let other = -1
  if (direction === "up") {
    for (let i = at - 1; i >= 0; i -= 1) {
      if (features.has(links[i].destination_id)) {
        other = i
        break
      }
    }
  } else {
    for (let i = at + 1; i < links.length; i += 1) {
      if (features.has(links[i].destination_id)) {
        other = i
        break
      }
    }
  }
  if (other === -1) return []
  const sortKey =
    direction === "up"
      ? sortKeyBetween(links[other - 1]?.sort_key ?? null, links[other].sort_key)
      : sortKeyBetween(links[other].sort_key, links[other + 1]?.sort_key ?? null)
  return [{ op: "link", source: boardId, destination: featureId, sortKey }]
}

/**
 * A feature removed from the Features editor: its block and its value
 * blocks deleted, with the links from the values to the pictures. The
 * pictures stay on the board — one left with no parent is back in the
 * basket, as the editor's own delete leaves what a block held — and so
 * does any other content the feature block held. A delete has no inverse
 * (`inverseOps`), so this is the one write the board's Undo cannot take
 * back.
 */
export function removeFeatureOps(
  snapshot: GraphSnapshot,
  boardId: NoteId,
  featureId: string,
): Op[] {
  const state = boardFeature(snapshot, boardId, featureId)
  if (!state) return []
  return deleteBlockOps([featureId, ...state.values.map((value) => value.id)], snapshot)
}

/** What a value is named as: an existing value's id, the text of one to
 * find or create, or — for a link feature — the address of one, with the
 * title to give it, if any. */
export type ValueRef = { id: string } | { text: string } | { url: string; title?: string }

/**
 * The address a link value is made with, from what was typed: trimmed, a
 * scheme-less one taken as https (as a typed address is in a note), and
 * null for anything that is not a web address — nothing is made of it.
 */
export function boardLinkUrl(address: string): string | null {
  const trimmed = address.trim()
  if (trimmed === "") return null
  const url = hrefOf(trimmed)
  return isWebUrl(url) ? url : null
}

/** Whether two addresses name one page, a trailing slash aside. */
const sameUrl = (a: string, b: string) => a.replace(/\/$/, "") === b.replace(/\/$/, "")

/**
 * Give a picture a value of a feature, named by its block. A value that
 * is missing is created under the feature and the picture is linked
 * beneath it. A single-select feature first takes back any other value of
 * its own the picture carried. Nothing to do (the picture already carries
 * exactly this, or there is no such feature) is an empty batch.
 *
 * A link feature's value is made from an address (`{ url }`): a link block
 * titled as given, else by the address's host, as a pasted address is
 * named, with its preview to follow (`linkPreviewOps`); an address already
 * on the board, a trailing slash aside, is reused. A name given to a link
 * feature, or an address to any other, makes nothing.
 */
export function setValueOps(
  snapshot: GraphSnapshot,
  boardId: NoteId,
  featureId: string,
  imageId: string,
  ref: ValueRef,
): Op[] {
  if (!isBoard(snapshot, boardId) || !snapshot.nodes.has(imageId)) return []
  const state = boardFeature(snapshot, boardId, featureId)
  if (!state) return []
  const { feature, values } = state
  const ops: Op[] = []

  let valueId: string
  if ("id" in ref) {
    if (!values.some((value) => value.id === ref.id)) return []
    valueId = ref.id
  } else {
    // The value to find, or what to make when it is not there.
    let existing: BoardValue | undefined
    let made: { type: string; text: string; props: string | null }
    if ("url" in ref) {
      if (!isLinkType(feature.type)) return []
      const url = boardLinkUrl(ref.url)
      if (url === null) return []
      existing = values.find((value) => value.link !== undefined && sameUrl(value.link.url, url))
      const title = ref.title?.trim() ?? ""
      made = { type: LINK_BLOCK_TYPE, text: title || hostOf(url), props: propsJson({ url }) }
    } else {
      if (isLinkType(feature.type)) return []
      const text = ref.text.trim()
      if (text === "") return []
      existing = values.find((value) => sameLabel(value.text, text))
      made = { type: VALUE_BLOCK_TYPE, text, props: null }
    }
    if (existing) {
      valueId = existing.id
    } else {
      valueId = blockId()
      ops.push(
        { op: "create", id: valueId, ...made, notesId: boardId },
        {
          op: "link",
          source: featureId,
          destination: valueId,
          sortKey: keyAtEnd(snapshot, featureId),
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

/**
 * The page's preview, landed for a link value — asked for as the editor
 * asks when a link block is made (`fetchLinkPreview`), and written as the
 * editor writes it (`withLinkPreview`). The page's title is taken where the
 * value has no name of its own but the host it was made with, so the
 * picker and the Filter menu can call the page what it calls itself; a
 * name given since is kept. Nothing for a block that is gone, or that no
 * longer points where the preview was asked for.
 */
export function linkPreviewOps(
  snapshot: GraphSnapshot,
  valueId: string,
  url: string,
  preview: LinkPreview,
): Op[] {
  const node = snapshot.nodes.get(valueId)
  if (!node || node.deleted_at || linkOf(node)?.url !== url) return []
  const props = parseProps(node.props)
  const ops: Op[] = [
    { op: "setProps", id: valueId, props: propsJson(withLinkPreview({ props }, preview)) },
  ]
  const title = preview.title?.trim() ?? ""
  const named = node.text.trim() !== "" && node.text.trim() !== hostOf(url)
  if (title !== "" && !named) ops.push({ op: "setText", id: valueId, text: title })
  return ops
}

/** The board's features as the tagging route is told them (docs/boards.md,
 * "Tagging with Claude"): each label, whether it takes several values,
 * what it means, the values in use, and — for a place feature — that the
 * location hint is its. A link feature is not among them: the model is
 * not asked where a picture came from. */
export function tagFeaturesOf(snapshot: GraphSnapshot, boardId: NoteId): TagFeature[] {
  return boardFeatures(snapshot, boardId).flatMap((state) => {
    const { feature } = state
    if (isLinkType(feature.type)) return []
    return [
      {
        label: feature.label,
        multi: feature.multi,
        ...(feature.meaning !== "" ? { meaning: feature.meaning } : {}),
        values: state.values.map((value) => value.text.trim()).filter((text) => text !== ""),
        ...(feature.type === "place" ? { place: true } : {}),
      },
    ]
  })
}

/**
 * A suggestion from Claude (`TagSuggestion`, src/data/auto-tag.ts) as the
 * writes it amounts to: one batch, undoable as one. It FILLS IN, never
 * overrides — a caption is written only where the picture has none, a
 * single-value feature only where the picture carries none of its values,
 * and a multi-value feature's values are added to those carried. Each
 * value goes through `setValueOps` with the text, so an existing value is
 * reused and a new one created, the batch built up against the snapshot as
 * each write would leave it. The answer names features by their labels, as
 * it was told them. An empty batch is a suggestion with nothing to add.
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

  for (const { feature } of boardFeatures(snapshot, boardId)) {
    // A link is not the model's to suggest, whatever the answer names.
    if (isLinkType(feature.type)) continue
    const answer = suggestion.features.find((entry) => sameLabel(entry.label, feature.label))
    if (!answer) continue
    const state = boardFeature(current, boardId, feature.id)
    const carried = state ? imageValues(current, state, imageId) : []
    if (!feature.multi && carried.length > 0) continue
    const carriedTexts = new Set(carried.map((value) => normalise(value.text)))
    for (const text of feature.multi ? answer.values : answer.values.slice(0, 1)) {
      if (carriedTexts.has(normalise(text))) continue
      take(setValueOps(current, boardId, feature.id, imageId, { text }))
    }
  }
  return ops
}

/**
 * A picture back to how it was uploaded — the inspector's **Reset**: its
 * caption cleared and every value taken off, all features at once, one
 * batch with one Undo. The values stay for the other pictures; a picture
 * left with no parent is back in the basket. Nothing when it has no
 * caption and carries no value.
 */
export function resetImageOps(snapshot: GraphSnapshot, boardId: NoteId, imageId: string): Op[] {
  if (!isBoard(snapshot, boardId)) return []
  const ops: Op[] = [...setCaptionOps(snapshot, imageId, "")]
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
