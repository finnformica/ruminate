import copy from "copy-to-clipboard"
import { useAtomValue, useSetAtom } from "jotai"
import { toast } from "sonner"
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type React from "react"
import type { ClipboardEvent, FocusEvent, KeyboardEvent, MouseEvent, TouchEvent } from "react"
import { isDatabaseModeAtom, newBlockMarkerAtom } from "../../global-state"
import { useFeature } from "../../data/features"
import { sharedOriginAtom } from "../../data/shared-mode"
import { shareDialogAtom } from "../share-note-dialog"
import type { Block, BlockDoc, BlockType, ChangeHint } from "../../blocks/types"
import type { BlockOp } from "../../blocks/history"
import { blockId } from "../../blocks/id"
import {
  beginPendingImage,
  downloadImage,
  imageFilesOf,
  ImageUploadError,
  primeImageObjectUrl,
  releasePendingImage,
  type UploadedImage,
} from "../../data/images"
import {
  figureAlignOf,
  figureLayoutOf,
  isFigureType,
  withFigureLayout,
  type FigureAlign,
} from "../../blocks/figure"
import {
  hostOf,
  hrefOf,
  isWebUrl,
  linkPropsOf,
  linkifyPastedText,
  linksInText,
  wholeTextLink,
  withLinkPreview,
  type LinkPreview,
} from "../../blocks/link"
import { LinkPreviewError } from "../../data/link-previews"
import { openLink } from "./link-card"
import { ImageLightbox } from "./image-lightbox"
import { MobileEditBar } from "./mobile-edit-bar"
import { SelectionBar } from "./selection-bar"
import { NoteTitle } from "./note-title"
import { useCoarsePointer } from "../../hooks/coarse-pointer"
import { useWriteView } from "../../hooks/views"
import { pinnedRootIdsAtom } from "../../data/views"
import {
  isHeading,
  leadingMarker,
  titlesFocus,
  toggleType,
  TURN_INTO_KEYS,
  typeOfMarker,
} from "../../blocks/markers"
import {
  runCommand,
  type CaretInput,
  type CommandInput,
  type CommandName,
  BROWSE_COMMANDS,
  type CommandResult,
  type FocusIntent,
  type Mode,
} from "../../blocks/commands"
import { resolveKey, type KeyLike } from "../../blocks/keymap"
import { parse } from "../../blocks/parse"
import { blockLines } from "../../blocks/serialize"
import {
  ancestorKeys,
  buildRows,
  firstOccurrenceKey,
  hasOccurrence,
  type Occurrence,
  idOfKey,
  isWithin,
  keyOf,
  occurrenceKeys,
  parentKeyOf,
  focusRootKeyOf,
} from "../../blocks/view"
import {
  dropGhost,
  ghostFold,
  measureRows,
  settleFold,
  unfoldBox,
  type RowPositions,
} from "./fold-motion"

/** The rows of a list grouped under their parent's key, in order. */
function childrenByParent(list: readonly Occurrence[]): Map<string | null, Occurrence[]> {
  const map = new Map<string | null, Occurrence[]>()
  for (const row of list) {
    const parent = parentKeyOf(row.key)
    const siblings = map.get(parent)
    if (siblings) siblings.push(row)
    else map.set(parent, [row])
  }
  return map
}

/**
 * A row's children, as one box beneath it: the box the fold animates
 * (fold-motion.ts). It unfolds when its parent has just been opened
 * (`opening`) — its edge sweeping down to reveal it while the rows below
 * slide out of its way. A fold does not touch it: its ghost, a clone of
 * its DOM, is covered in its place while it goes with the state change
 * (`ghostFold`). At rest it is a plain wrapper, nothing clipped, so a
 * to-do's chevron beside its checkbox and a heading's hash, both of which
 * reach beyond their row, always show. The inner div is the body the
 * sweep slides against the box.
 */
function Subtree({
  parentKey,
  opening,
  children,
}: {
  parentKey: string
  opening: boolean
  children: React.ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (ref.current && opening) unfoldBox(ref.current)
  }, [opening])
  return (
    <div ref={ref} data-subtree={parentKey}>
      <div>{children}</div>
    </div>
  )
}

import {
  duplicateBlocks,
  emptyBlock,
  indentBlock,
  insertBlocksAsFirstChildren,
  insertAfter,
  insertFirstChild,
  moveBlocks,
  outdentBlock,
  remintCollidingIds,
  removeBlock,
  spliceBlocks,
  updateBlock,
  updateType,
  subtreeIds,
  type BlockPatch,
} from "../../blocks/ops"
import { cx } from "../../utils/cx"
import { htmlToMarkdown } from "../../utils/html-to-markdown"
import {
  clipboardBlocksToDoc,
  clipboardBlocksToDocWithIds,
  extractClipboardBlocks,
  richClipboardFormats,
  writeRichClipboard,
  type ClipboardBlock,
} from "../../utils/rich-clipboard"
import {
  BlockContextMenu,
  BlockMenuSheet,
  type BlockMenuActions,
  type BlockMenuTarget,
} from "./block-context-menu"
import {
  BlockItem,
  type BlockDebugOptions,
  type BlockEditorApi,
  type FocusRequest,
} from "./block-item"
export type { BlockDebugOptions } from "./block-item"
import { useBlockHistory } from "./use-block-history"

/** The first row (in document order) of a block present in `restored` but
 * not in `current` — the block an undo brought back, e.g. after a delete. */
function findReappeared(current: BlockDoc, restored: BlockDoc): string | null {
  return occurrenceKeys(restored).find((key) => !(idOfKey(key) in current.blocks)) ?? null
}

/**
 * The fragment a Ruminate clipboard payload lands as, under the selected row.
 *
 * Within Ruminate, paste means "put this block here": the copied node itself
 * goes downstream of the target, not a copy of its content. Per pasted root:
 *
 * - **Twin**: its id is already a direct child of the insertion parent — skip
 *   it (no duplicate, no error; it's already there). The DB's
 *   `(source, destination, kind)` primary key backstops this.
 * - **Link, same note**: its id lives elsewhere in this doc — mirror it: the
 *   node goes under the target as well, taken from the doc's own copy (the
 *   live one), so the note holds it in two places and both rows are the one
 *   block. The view keys rows by occurrence, so each row selects and edits
 *   on its own while the text is shared.
 * - **Link, another note**: its id is unknown here — insert the node itself,
 *   original ids preserved, using its LIVE content from the corpus
 *   (`resolveBlocks`), never the clipboard bytes (a stale clipboard must not
 *   clobber the live node on save). A node that no longer exists anywhere
 *   (deleted since copy — the cut side of cut+paste) falls back to the
 *   clipboard content, still under its original ids, which is what makes
 *   cut+paste a true move.
 * - **No id** (an older payload): duplicate with fresh ids.
 *
 * Linking a block beneath one of its own descendants closes a loop, and a
 * loop is a shape the graph holds (docs/graph-schema-v2.md, "Loops"): the
 * outline shows it where it closes and no further. Only a block under
 * itself is refused (the paste handler drops that root).
 *
 * A node the linked subtree shares with the rest of the doc, or with another
 * pasted root, is simply the same node in one more place — never reminted.
 *
 * Returns null when every root was a twin (nothing to insert).
 */
function embeddedPasteFragment(
  embedded: ClipboardBlock[],
  doc: BlockDoc,
  /** The row pasted onto: the fragment lands as its block's first children. */
  targetKey: string,
  resolveBlocks?: (ids: string[]) => Record<string, string | null>,
): BlockDoc | null {
  const target = idOfKey(targetKey)
  // Direct children of the insertion parent (the twin check's scope).
  const parentChildren = doc.blocks[target]?.children ?? []

  const roots = embedded.filter(
    (block) => !(block.id !== undefined && parentChildren.includes(block.id)),
  )
  if (roots.length === 0) return null

  const inDoc = (block: ClipboardBlock) => block.id !== undefined && block.id in doc.blocks
  const linkableIds = roots
    .filter((block) => block.id !== undefined && !inDoc(block))
    .map((block) => block.id as string)
  const resolved =
    resolveBlocks && linkableIds.length > 0 ? resolveBlocks(linkableIds) : ({} as const)

  let out: BlockDoc = { props: null, rootBlockIds: [], blocks: {} }
  for (const block of roots) {
    let sub: BlockDoc
    if (block.id === undefined) {
      sub = clipboardBlocksToDoc([block])
    } else if (inDoc(block)) {
      sub = subtreeDoc(doc, block.id)
    } else {
      const live = (resolved as Record<string, string | null>)[block.id] ?? null
      sub = live !== null ? parse(live) : clipboardBlocksToDocWithIds([block])
      // A block the doc already holds keeps the doc's copy — the live subtree
      // only supplies what this doc has not seen (a loop back into the doc
      // names the doc's own block, and must not overwrite it).
      for (const id of Object.keys(sub.blocks)) if (id in doc.blocks) delete sub.blocks[id]
    }
    out = {
      props: null,
      rootBlockIds: [...out.rootBlockIds, ...sub.rootBlockIds],
      blocks: { ...out.blocks, ...sub.blocks },
    }
  }
  return out
}

/** The subtree under `id` as this doc holds it, as a fragment rooted there. */
function subtreeDoc(doc: BlockDoc, id: string): BlockDoc {
  const blocks: Record<string, Block> = {}
  for (const sid of subtreeIds(doc, id)) blocks[sid] = doc.blocks[sid]
  return { props: null, rootBlockIds: [id], blocks }
}

/** One step of the focus navigation stack: the block focused on, with the
 * text it was last seen with (the breadcrumb's label for it once the view has
 * moved on to a block beneath it). */
interface FocusHop {
  id: string
  text: string
}
const hopOf = (doc: BlockDoc, id: string): FocusHop => ({ id, text: doc.blocks[id]?.text ?? "" })

/**
 * A controlled block outliner. `doc` is owned by the caller (which serializes
 * and saves it); this component manages only transient UI state and emits new
 * docs via `onChange`.
 *
 * There are two modes, like Notion:
 * - **select** — a block is highlighted; arrow keys move the highlight and
 *   Enter (or a double-click) starts editing it. This is the default.
 * - **edit** — a textarea is focused inside the block; Escape returns to
 *   select, and arrows at the first/last line move to the adjacent block.
 *
 * Each block's content is raw markdown, rendered per-block and edited in place.
 */
/** The block editor whose container last took focus — where a page-level
 * ⌘Z goes when nothing editable has it (see the window listener below). */
let lastActiveEditor: HTMLElement | null = null

/** Where a page-level ⌘Z is somebody else's: form fields, dialogs and menus,
 * and any block editor (each handles its own on its container). */
const UNDO_KEEPS_TO_ITSELF =
  'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [data-block-editor]'

/** Where an Up/Down arrow is somebody else's: everything ⌘Z leaves alone,
 * plus the widgets that walk their options with the arrows (a listbox, a
 * combobox, a tab list, a radio group, a tree or grid). A plain button or
 * link uses them for nothing, so the editor takes them back. */
const ARROWS_KEEP_TO_THEMSELVES = `${UNDO_KEEPS_TO_ITSELF}, [role="listbox"], [role="combobox"], [role="tablist"], [role="radiogroup"], [role="tree"], [role="grid"], [role="slider"]`

/** What a pointer-down may land on and NOT count as a click on blank space
 * (see `pointerIdle`): any real control. The editor container is tabindex -1
 * and is deliberately absent, so a click in its gaps is blank. */
const BLANK_CLICK_EXCLUDES =
  'a[href], button, input, textarea, select, [contenteditable="true"], [tabindex]:not([tabindex="-1"])'

/** Whether the editor still owns the keyboard with focus on `active`: inside
 * its container, or on the selection bar or a menu — the bar's, or the block
 * menu — which act on the very selection the highlight shows, so it stays
 * lit while they are used. */
function ownsFocus(container: HTMLElement, active: Element | null): boolean {
  if (!active) return false
  return (
    container.contains(active) || active.closest('[data-selection-bar], [role="menu"]') !== null
  )
}

/** How the finger that opened the block sheet announces its lift, and how
 * long after it the sheet's rows start taking taps: long enough for the
 * click the browser owes the lift to have landed and been ignored. */
const LIFT_EVENTS = ["touchend", "touchcancel", "pointerup", "pointercancel"] as const
const LIFT_GRACE = 250

/** Keys that are only modifiers: pressing one alone is not "using the keyboard". */
const MODIFIER_KEYS = new Set(["Shift", "Meta", "Control", "Alt", "CapsLock"])

/** Why an edit to a results view's root list did nothing (`fixedRoots`). */
const FIXED_ROOTS_NOTICE = "Open the note to add or remove blocks at this level"

/** The nearest ancestor that scrolls vertically, if any (the document's own
 * scrolling is the window's — not counted). */
function scrollParentOf(el: Element): Element | null {
  for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if (overflow === "auto" || overflow === "scroll") return node
  }
  return null
}

/** Same roots, same order — what `fixedRoots` holds an edit to. */
function sameRoots(prev: BlockDoc, next: BlockDoc): boolean {
  return (
    prev.rootBlockIds.length === next.rootBlockIds.length &&
    prev.rootBlockIds.every((id, index) => id === next.rootBlockIds[index])
  )
}

export function BlockEditor({
  doc,
  onChange,
  startEditing = false,
  collapsed: collapsedProp,
  onToggleCollapse,
  onReveal,
  onExitTop,
  onExitBottom,
  focusFirstSignal,
  focusLastSignal,
  focusFirstMode = "select",
  initialSelection = "first",
  newRootSignal,
  refocusSignal,
  readOnly = false,
  browse = false,
  focusRootId: focusRootIdProp = null,
  onFocusNavigate,
  noteTitle,
  resolveBlocks,
  debug,
  noteId,
  parentCountOf,
  onDeleteEverywhere,
  onDeleteSubtree,
  knownBlock,
  onImageUpload,
  onLinkPreview,
  onActivate,
  fixedRoots = false,
  emptyable = false,
  context,
}: {
  doc: BlockDoc
  /** The next doc, and what the change means beyond it (`ChangeHint`). */
  onChange: (doc: BlockDoc, hint?: ChangeHint) => void
  /**
   * Upload a pasted/dropped picture and return what the image block should
   * hold (`src/data/images.ts`). Absent = images are switched off here: an
   * image paste or drop is left to the browser and the slash menu offers no
   * "Image".
   */
  onImageUpload?: (file: File) => Promise<UploadedImage>
  /**
   * Fetch what a page says about itself, for a link block's card
   * (`src/data/link-previews.ts`). Absent = no session to fetch it through: a
   * link block is still made, with its address alone, and the menu offers
   * no "Refresh preview".
   */
  onLinkPreview?: (url: string) => Promise<LinkPreview>
  /** The note this doc belongs to — what "Copy link to block" links into. */
  noteId?: string
  /** How many places a block appears across the corpus (whether the context
   * menu offers Unlink beside Delete). Absent = only here. */
  parentCountOf?: (id: string) => number
  /** Delete a block from every place it appears (the graph-level delete);
   * absent standalone, where the menu offers only the row's removal. */
  onDeleteEverywhere?: (id: string) => void
  /** Delete a block and everything beneath it that nothing else holds
   * (`deleteSubtreeOps`); the basket's menu offers it. Absent elsewhere. */
  onDeleteSubtree?: (id: string) => void
  /** Whether the graph already holds a block — what tells a block an edit
   * created from one it linked in, for undo (`useBlockHistory`). Absent =
   * nothing is known, so every block an edit brings in counts as created. */
  knownBlock?: (id: string) => boolean
  /** Start with the first block in edit mode (e.g. a brand-new note). */
  startEditing?: boolean
  /**
   * Folded occurrence keys (`src/blocks/view.ts`). Optional: when provided
   * (with `onToggleCollapse`), collapse is controlled and persisted by the
   * caller; otherwise it falls back to transient local state (e.g. Storybook /
   * standalone usage).
   */
  collapsed?: Set<string>
  onToggleCollapse?: (key: string) => void
  /** Record a row as open in its own right, over whatever the fold rule
   * would say (`reveal`). Absent, a reveal falls back to the toggle, which
   * is all transient local state needs. */
  onReveal?: (key: string) => void
  /** Called when the user navigates up past the first block — lets the caller
   * move focus to whatever sits above the editor (e.g. the note title). */
  onExitTop?: () => void
  /** Called when the user navigates down past the last block — lets the
   * caller move focus to whatever sits below the editor (a second results
   * list). Without it the key is consumed and the last row stays. */
  onExitBottom?: () => void
  /** Bump this (e.g. Down-arrow from the note title) to focus the first block. */
  focusFirstSignal?: number
  /** Bump this (↑ from a list beneath the editor) to focus the last block. */
  focusLastSignal?: number
  /** Whether `focusFirstSignal` opens the first block editing or just highlighted. */
  focusFirstMode?: "edit" | "select"
  /** What is highlighted on mount: the first block (a note), or nothing
   * until the keyboard arrives (the palette's lists). */
  initialSelection?: "first" | "none"
  /** Bump this (e.g. Cmd+Enter on the note title) to add a new root block. */
  newRootSignal?: number
  /** Bump this (the global `i` shortcut) to refocus the editor, restoring the
   * last selected block (or the first). */
  refocusSignal?: number
  /** Display-only: renders blocks without any editing (e.g. past-day history). */
  readOnly?: boolean
  /**
   * A read-only editor the reader still moves through — a note someone
   * shared with them (docs/sharing.md): the highlight moves, a click
   * highlights, folds open and close, `f` focuses (through `onFocusNavigate`),
   * and nothing writes (`BROWSE_COMMANDS`). Implied by `onActivate`. Without
   * either, a read-only editor is inert display (a preview).
   */
  browse?: boolean
  /**
   * Open a row — what Enter and a click do in a read-only view that is
   * browsed with somewhere to go: the notes list, a search's results.
   */
  onActivate?: (id: string) => void
  /**
   * The roots are the view's own, not a parent's children — a results
   * list's hits, the notes list's notes — so there is nowhere for a new root
   * to go and nothing a removed one leaves. An edit that would add, remove
   * or reorder them is refused with a notice; everything beneath a root
   * edits as it does in its note.
   */
  fixedRoots?: boolean
  /**
   * Rows the view keeps only as context — the unmatched ancestors of a
   * filtered view's matches (`src/data/filter-view.ts`), drawn dimmed. The
   * doc is otherwise the note's own, so a filtered view edits, folds and
   * navigates exactly as the note does.
   */
  context?: ReadonlySet<string>
  /**
   * Whether the doc may be left with no blocks at all. Off, the only root
   * cannot be removed (⌫ on it does nothing): a note always keeps a block to
   * type in. On for a view whose rows are all it is — the Unassigned basket,
   * where removing the last block empties the basket, which then goes.
   */
  emptyable?: boolean
  /**
   * Focus mode: the block whose subtree is the whole view. With
   * `onFocusNavigate` the focus is controlled by the caller (URL search param);
   * without it, this is just the initial value of transient local focus state
   * (Storybook / tests).
   */
  focusRootId?: string | null
  /** Called to change the focus root (`null` leaves focus). Makes focus
   * controlled. */
  onFocusNavigate?: (id: string | null) => void
  /** The note's title — the breadcrumb's first crumb while focused. (The
   * focused block itself is drawn as the view's title beneath the breadcrumb,
   * by the same `NoteTitle` the page draws the note's with.) */
  noteTitle?: string
  /**
   * Live subtree markdown per block id from the note corpus — the "paste as
   * link" lookup (see `embeddedPasteFragment`). Optional: without it
   * (Storybook, standalone usage) unknown-id pastes fall back to the
   * clipboard-embedded content, ids intact.
   */
  resolveBlocks?: (ids: string[]) => Record<string, string | null>
  /**
   * Developer-mode debug readouts (block ids beside rows, metadata beneath
   * them — `src/hooks/is-developer.ts`). Absent in ordinary use.
   */
  debug?: BlockDebugOptions
}) {
  // A read-only view still owns the keyboard when it is browsed (`browse`,
  // or `onActivate`, which opens rows); one that is neither is inert display.
  const navigable = !readOnly || browse || onActivate !== undefined
  // A touch screen (docs/mobile.md): a tap edits, the edit bar sits above
  // the keyboard, and a highlight has no job once the edit ends.
  const coarse = useCoarsePointer()

  // ── Focus state ────────────────────────────────────────────────────────────
  // Controlled by the caller (URL) when `onFocusNavigate` is given; otherwise
  // transient local state so the editor works standalone.
  const [focusInternal, setFocusInternal] = useState<string | null>(focusRootIdProp)
  const focusRootId = onFocusNavigate ? focusRootIdProp : focusInternal

  // The focus NAVIGATION stack: the blocks focused on, in the order the user
  // took — the breadcrumb and Shift+F follow this path, not the tree ancestry
  // (under the graph model a block can live in several places, so "the path
  // you took" is the only honest trail). Reconciled from focusRootId so every
  // way of changing focus (keyboard, the edit bar, crumb click, browser back,
  // deep link) keeps it consistent: navigating to an id already on the stack
  // truncates back to it; anything else is a new hop and pushes.
  //
  // Each hop keeps the text it was seen with. In focus the page hands the
  // editor the focused block's own view (`useNoteDoc`), so the blocks focused
  // on before it are not in the doc to be read — and the crumbs still have
  // to name them. The texts are refreshed from whatever doc does hold them
  // (a deep link's doc can arrive after its hop), without a new stack for an
  // edit that changes none of them.
  const [focusStack, setFocusStack] = useState<FocusHop[]>(() =>
    focusRootId ? [hopOf(doc, focusRootId)] : [],
  )
  useEffect(() => {
    setFocusStack((stack) => {
      if (!focusRootId) return stack.length === 0 ? stack : []
      const at = stack.findIndex((hop) => hop.id === focusRootId)
      const next =
        at === -1
          ? [...stack, hopOf(doc, focusRootId)]
          : at === stack.length - 1
            ? stack
            : stack.slice(0, at + 1)
      let changed = next !== stack
      const refreshed = next.map((hop) => {
        const text = doc.blocks[hop.id]?.text
        if (text === undefined || text === hop.text) return hop
        changed = true
        return { id: hop.id, text }
      })
      return changed ? refreshed : stack
    })
  }, [focusRootId, doc])
  // Where Shift+F returns to: one step back along the path (null leaves focus).
  const focusBackId = focusStack.length > 1 ? focusStack[focusStack.length - 2].id : null
  // What Enter puts in a fresh block — a user preference (Settings → Editor).
  const newBlockMarker = useAtomValue(newBlockMarkerAtom)

  const navigateFocus = (id: string | null) => {
    if (onFocusNavigate) onFocusNavigate(id)
    else setFocusInternal(id)
  }
  const focusRoot = focusRootId ? (doc.blocks[focusRootId] ?? null) : null
  // How the focused block is drawn (`titlesFocus`, src/blocks/markers.ts): a
  // heading is the view's TITLE, above the rows, as the note's own title is
  // (the same `NoteTitle`, fed the block's text) — leaving the first row
  // upward (`exitTop`) selects it, and its children are the rows. Anything
  // else is content rather than a name, so it leads the view as its first
  // ROW and the outline below it is untouched.
  const focusTitled = focusRoot !== null && titlesFocus(focusRoot.type)
  // The focused block's key — its first occurrence in the document — which
  // its children's row keys hang off (and which is its own row's key, where
  // it has one).
  const focusRootKey = useMemo(
    () => (focusRoot ? focusRootKeyOf(doc, focusRoot.id) : null),
    [doc, focusRoot],
  )
  // The same key, but only where it names the title rather than a row: what
  // the rules that hold for "there is something above the rows" key off.
  const focusTitleKey = focusTitled ? focusRootKey : null
  const [focusTitleSignal, setFocusTitleSignal] = useState(0)

  // Everything positional — the selection, its anchor, edit focus — is a row:
  // an occurrence key (`src/blocks/view.ts`), so a block that appears twice
  // in the note is two places to be. The block itself is by id.

  // The first selectable row: in focus under a title, the focus root's first
  // child (the title is not a row; a childless focus has no row to land on);
  // in focus without one, the focus root's own row.
  const firstKey =
    focusRoot && focusRootKey
      ? !focusTitled
        ? focusRootKey
        : focusRoot.children[0]
          ? keyOf(focusRootKey, focusRoot.children[0])
          : null
      : (doc.rootBlockIds[0] ?? null)
  const [focus, setFocus] = useState<FocusRequest | null>(() =>
    startEditing && firstKey ? { key: firstKey } : null,
  )
  // A note opens with its first block highlighted. A caller can ask for
  // nothing highlighted until the keyboard arrives (`initialSelection:
  // "none"` — the palette's lists: two under one query would otherwise each
  // show a highlight, and neither where the keys are).
  const [selected, setSelected] = useState<string | null>(() =>
    initialSelection === "none" ? null : firstKey,
  )
  const [collapsedInternal, setCollapsedInternal] = useState<Set<string>>(new Set())
  const collapsed = collapsedProp ?? collapsedInternal
  // The other end of a multi-row selection (Shift+Arrow). null = single select.
  const [anchorKey, setAnchorKey] = useState<string | null>(null)
  const rawHistory = useBlockHistory(onChange, knownBlock)
  // Under `fixedRoots` a change to the root list has nowhere to land (see the
  // prop): it is refused here, at the one funnel every edit goes through,
  // with a notice — so a split at the end of a matched block, a Backspace on
  // one, a paste over one, all say why nothing happened.
  const history = fixedRoots
    ? {
        ...rawHistory,
        commit: (prev: BlockDoc, next: BlockDoc, op: BlockOp) => {
          if (!sameRoots(prev, next)) {
            toast(FIXED_ROOTS_NOTICE)
            return
          }
          rawHistory.commit(prev, next, op)
        },
      }
    : rawHistory

  // The view: the rows on screen, in order, indented by depth, folds applied
  // (`buildRows`). In focus under a title, the focused block leads as the view's
  // editable title (so arrow-up from the first child selects it) and its
  // children always render — the root's own fold is ignored. Without one, the
  // block is simply the first row, its subtree beneath it.
  const rows = useMemo(
    () =>
      buildRows(doc, {
        focusRootId: focusRoot ? focusRoot.id : null,
        focusTitled,
        folds: collapsed,
        rootId: noteId ?? null,
      }),
    [doc, collapsed, focusRoot, focusTitled, noteId],
  )
  // The rows' keys in the order they appear on screen — what up/down
  // navigation and a Shift+Arrow range walk.
  const visibleOrder = useMemo(() => rows.map((row) => row.key), [rows])
  // The container is the focusable keyboard target for select mode.
  const containerRef = useRef<HTMLDivElement>(null)

  // ── Keyboard ownership ────────────────────────────────────────────────────
  // Whether the editor owns the keyboard: focus (container or a textarea) is
  // inside the container. While it doesn't — focus moved to the sidebar, a
  // dialog, the ⌘K palette — the selection highlight demotes to a
  // quiet neutral (`.block-highlight-inactive`), Finder-style, so "arrows work
  // here" is never claimed falsely. Tracked via the container's focus/blur
  // (they bubble, i.e. focusin/focusout); the blur side settles on a rAF so
  // internal focus moves (container ↔ textarea, the blur-regrab below) never
  // flicker — both the check and any re-grab run before the next paint.
  //
  // Focus alone over-claims, though: a click on blank space (the page margin,
  // the gap between rows) leaves the container focused — or re-grabs it, see
  // handleContainerBlur — so the keys still work, yet the user just pointed
  // at nothing. `pointerIdle` records that: set by a pointer-down that lands
  // on neither a row nor a focusable control, cleared by the next key press
  // in the editor or a click on a row. While it is set the selection shows
  // as inactive even with focus in hand, and the first arrow key lights it
  // up again — the :focus-visible idea, applied to the selection.
  const [keyboardActive, setKeyboardActive] = useState(false)
  const [pointerIdle, setPointerIdle] = useState(false)
  useEffect(() => {
    const onPointerDown = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null
      if (!target) return
      if (target.closest("[data-block-line]")) {
        setPointerIdle(false)
        return
      }
      // The container itself is tabindex -1, so a click in its gaps counts
      // as blank; any real control (a nav link, an input, a dialog) does not.
      if (!target.closest(BLANK_CLICK_EXCLUDES)) setPointerIdle(true)
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    return () => document.removeEventListener("pointerdown", onPointerDown, true)
  }, [])
  const keyboardIdleRaf = useRef<number | null>(null)
  const cancelKeyboardIdleCheck = () => {
    if (keyboardIdleRaf.current !== null) {
      cancelAnimationFrame(keyboardIdleRaf.current)
      keyboardIdleRaf.current = null
    }
  }
  const handleContainerFocus = () => {
    cancelKeyboardIdleCheck()
    setKeyboardActive(true)
    lastActiveEditor = containerRef.current
  }
  const scheduleKeyboardIdleCheck = () => {
    cancelKeyboardIdleCheck()
    keyboardIdleRaf.current = requestAnimationFrame(() => {
      keyboardIdleRaf.current = null
      const el = containerRef.current
      if (!el || !ownsFocus(el, document.activeElement)) setKeyboardActive(false)
    })
  }
  useEffect(() => cancelKeyboardIdleCheck, [])
  // Set by a Cmd/Ctrl+Shift+V keydown so the paste event that follows knows to
  // paste as plain text (newlines collapsed into one block).
  const plainPasteRef = useRef(false)
  const focusContainer = () => {
    if (navigable) containerRef.current?.focus({ preventScroll: true })
  }

  // The latest doc, for effects and handlers that must not re-run on every
  // edit.
  const docRef = useRef(doc)
  docRef.current = doc

  // Graceful focus exit: if the focused block no longer exists (deleted, undo, a
  // stale/bad link), fall back to the unfocused view AND clean the URL param —
  // obsidian-zoom's "reset when boundaries violated" principle.
  useEffect(() => {
    if (focusRootId && !doc.blocks[focusRootId]) navigateFocus(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRootId, doc])

  // Place the selection when the focus root changes: focusing lands on the
  // block itself where it leads the view as a row, else on its first child
  // (not the title, avoiding accidental edits of the root); stepping back
  // lands on the block left BEHIND (it's visible in the wider view). Covers
  // F/Shift+F, crumb clicks, and the browser back button.
  const prevFocusRef = useRef(focusRootId)
  useEffect(() => {
    const prev = prevFocusRef.current
    if (prev === focusRootId) return
    prevFocusRef.current = focusRootId
    if (!navigable) return
    const current = docRef.current
    setAnchorKey(null)
    setFocus(null)
    if (focusRootId) {
      const root = current.blocks[focusRootId]
      if (!root) return // the graceful-exit effect above cleans this up
      const rootKey = focusRootKeyOf(current, focusRootId)
      // Stepped back to an ancestor: the block we came from has a row inside
      // the new view — land there.
      const back =
        prev === null
          ? undefined
          : occurrenceKeys(current).find((key) => isWithin(key, rootKey) && idOfKey(key) === prev)
      if (back) setSelected(back)
      // Untitled: the block is the view's first row — land on it.
      else if (!titlesFocus(root.type)) setSelected(rootKey)
      else if (root.children[0]) setSelected(keyOf(rootKey, root.children[0]))
      // Nothing beneath the block yet: the title takes the keyboard, so Enter
      // on it makes the first child.
      else setFocusTitleSignal((n) => n + 1)
    } else if (prev !== null) {
      const back = firstOccurrenceKey(current, prev)
      if (back) setSelected(back)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRootId, navigable])

  // Survives deselection (Escape, focus loss): the row `refocusSignal`
  // returns the user to.
  const lastSelectedRef = useRef(selected)
  if (selected) lastSelectedRef.current = selected

  // The selected rows. Single select is just `[selected]`; a Shift+Arrow
  // range is the contiguous span of `visibleOrder` between anchor and head.
  const selectedKeys: string[] = useMemo(() => {
    if (!selected) return []
    if (!anchorKey || anchorKey === selected) return [selected]
    const a = visibleOrder.indexOf(anchorKey)
    const b = visibleOrder.indexOf(selected)
    if (a === -1 || b === -1) return [selected]
    const [lo, hi] = a < b ? [a, b] : [b, a]
    return visibleOrder.slice(lo, hi + 1)
  }, [selected, anchorKey, visibleOrder])
  const selectedSet = useMemo(() => new Set(selectedKeys), [selectedKeys])

  // Where two selected rows' highlight surfaces touch on screen, the sides
  // between them get the FULL 4px vertical extension and straight corners so
  // the run reads as ONE continuous surface, rounded only at its ends (every
  // other side extends just 2px — to the midpoint of the nested 4px inter-row
  // gap — so differently-painted neighbours, e.g. a hover beside a selection,
  // never overlap; see the runEdges pairs in block-item.tsx). With 4px per
  // touching side, consecutive selected rows always meet (nested 4px gaps
  // overlap 4px, root 6px gaps overlap 2px) — except across a heading's top
  // margin (or the focus title's bottom margin), which keeps a visible gap;
  // those boundaries stay rounded.
  const selectionRunEdges = useMemo(() => {
    const edges = new Map<string, { top: boolean; bottom: boolean }>()
    if (selectedSet.size < 2) return edges
    const headingAt = (key: string) => isHeading(doc.blocks[idOfKey(key)]?.type ?? "text")
    for (let i = 0; i < visibleOrder.length; i++) {
      const key = visibleOrder[i]
      if (!selectedSet.has(key)) continue
      const prev = i > 0 ? visibleOrder[i - 1] : null
      const next = i + 1 < visibleOrder.length ? visibleOrder[i + 1] : null
      const top =
        prev !== null && selectedSet.has(prev) && !headingAt(key) && prev !== focusTitleKey
      const bottom =
        next !== null && selectedSet.has(next) && !headingAt(next) && key !== focusTitleKey
      if (top || bottom) edges.set(key, { top, bottom })
    }
    return edges
  }, [selectedSet, visibleOrder, doc, focusTitleKey])

  const select = (key: string, extend = false) => {
    setFocus(null)
    // Shift+click: the run from the selection's anchor (or its one row) to
    // the clicked row, as Shift+Arrow would have walked it.
    if (extend && selected) setAnchorKey(anchorKey ?? selected)
    else setAnchorKey(null)
    setSelected(key)
    // Grab keyboard focus so arrows work immediately, even re-clicking the block
    // that's already highlighted (which wouldn't trigger the focus effect).
    focusContainer()
  }

  // A pointer's sweep across the rows: the text selection it leaves is
  // turned into a selection of the rows it touched — the first to the last,
  // the anchor at the end the drag began — so what looks selected is
  // selected, and Tab, delete, the bar and the rest act on all of it. Before
  // this a Tab after such a sweep indented only the row the press landed
  // on. A sweep inside one row is left alone: that is text being selected.
  // Heard on the document, not the container: a sweep to the end of a note
  // lets go below its last row, outside the editor.
  const handleSweepEnd = () => {
    if (coarse || !navigable || focus) return
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) return
    const { keys } = pickSelectedRows(selection)
    if (keys.length < 2) return
    const first = keys[0]
    const last = keys[keys.length - 1]
    const startedAtEnd =
      selection.anchorNode instanceof Node &&
      Boolean(
        containerRef.current
          ?.querySelector(`[data-occurrence="${last}"]`)
          ?.contains(selection.anchorNode),
      )
    selection.removeAllRanges()
    setPointerIdle(false)
    setAnchorKey(startedAtEnd ? last : first)
    setSelected(startedAtEnd ? first : last)
    focusContainer()
  }
  const sweepEndRef = useRef(handleSweepEnd)
  sweepEndRef.current = handleSweepEnd
  useEffect(() => {
    const onMouseUp = () => sweepEndRef.current()
    document.addEventListener("mouseup", onMouseUp)
    return () => document.removeEventListener("mouseup", onMouseUp)
  }, [])

  // Extend the multi-selection by moving the head one row along, keeping the
  // anchor fixed (starting a range from the current head if there isn't one).
  const extendSelection = (direction: "up" | "down") => {
    if (!selected) return
    const i = visibleOrder.indexOf(selected)
    if (i === -1) return
    const next = direction === "up" ? i - 1 : i + 1
    if (next < 0 || next >= visibleOrder.length) return
    if (!anchorKey) setAnchorKey(selected)
    setFocus(null)
    setSelected(visibleOrder[next])
  }

  // ── Selection ladder (Cmd/Ctrl+A escalation) ──────────────────────────────
  // Repeated Cmd/Ctrl+A grows the selection through structural units — block →
  // its visible subtree → the parent's subtree → each ancestor → the whole
  // page — and Cmd/Ctrl+Shift+A steps back down. The escalation itself is
  // stateless (derived from the current selection each press); only the shrink
  // history lives in a ref, cleared whenever the selection changes by any
  // other means (arrows, click, Escape, structural edits). No timers.
  const ladderRef = useRef<{ selected: string; anchorKey: string | null }[]>([])
  // Set just before a ladder move's own setState so the clear effect below can
  // tell ladder-driven selection changes from everything else.
  const ladderMove = useRef(false)
  // Set by ladder moves so the centre-scroll effect can skip its jump when the
  // selection head is already fully on screen.
  const skipCenterScroll = useRef(false)
  useEffect(() => {
    if (ladderMove.current) {
      ladderMove.current = false
      return
    }
    ladderRef.current = []
  }, [selected, anchorKey, doc])

  // The contiguous run of `visibleOrder` covered by a row's subtree: the row
  // plus its visible descendants (just the row for a leaf or collapsed one).
  // Descendant rows are exactly the keys beneath it.
  const visibleSubtree = (key: string): string[] => {
    const start = visibleOrder.indexOf(key)
    if (start === -1) return []
    let end = start + 1
    while (end < visibleOrder.length && isWithin(visibleOrder[end], key)) end++
    return visibleOrder.slice(start, end)
  }

  // One rung up: grow `keys` (a contiguous run of `visibleOrder`) to the
  // visible subtree of the deepest row strictly containing it — the head row
  // itself when the selection is a strict subset of its own subtree, otherwise
  // the nearest ancestor whose subtree covers it — falling back to the whole
  // page (e.g. a selection spanning multiple roots). `snapshot` is the
  // selection to restore when Cmd/Ctrl+Shift+A steps back down.
  const escalateFrom = (
    keys: string[],
    snapshot: { selected: string; anchorKey: string | null },
  ) => {
    if (keys.length === 0 || visibleOrder.length === 0) return
    const first = keys[0]
    const last = keys[keys.length - 1]
    // `sub` when it strictly contains the selection (both endpoints of a
    // contiguous range inside another contiguous range ⇒ the whole range is).
    const strictSuperset = (rootKey: string): string[] | null => {
      const sub = visibleSubtree(rootKey)
      if (sub.length <= keys.length) return null
      return sub.includes(first) && sub.includes(last) ? sub : null
    }
    let target = strictSuperset(first)
    if (!target) {
      for (const ancestor of ancestorKeys(first)) {
        target = strictSuperset(ancestor)
        if (target) break
      }
    }
    const range = target ?? visibleOrder
    if (range.length <= keys.length) return // already the whole page
    ladderRef.current.push(snapshot)
    ladderMove.current = true
    skipCenterScroll.current = true
    setFocus(null)
    setSelected(range[0])
    setAnchorKey(range[range.length - 1])
  }
  const escalateSelection = () => {
    if (!selected) return
    escalateFrom(selectedKeys, { selected, anchorKey })
  }
  const shrinkSelection = () => {
    const prev = ladderRef.current.pop()
    if (!prev || !hasOccurrence(doc, prev.selected)) return
    ladderMove.current = true
    skipCenterScroll.current = true
    setFocus(null)
    setSelected(prev.selected)
    setAnchorKey(prev.anchorKey && hasOccurrence(doc, prev.anchorKey) ? prev.anchorKey : null)
  }

  // The top-level rows of the selection (those with no selected ancestor), in
  // document order — the roots to act on so a subtree is moved/copied once.
  const selectionRoots = (): string[] => {
    const set = selectedSet
    return selectedKeys.filter((key) => !ancestorKeys(key).some((ancestor) => set.has(ancestor)))
  }

  // Selection roots for *structural* ops — the rows to move, indent, outdent
  // or delete once each.
  const structuralRoots = selectionRoots

  // The first selectable row of a given doc, honouring the current focus.
  const firstSelectable = (d: BlockDoc): string | null => {
    if (focusRootId && d.blocks[focusRootId]) {
      const rootKey = focusRootKeyOf(d, focusRootId)
      // Untitled, the focused block's own row leads the view.
      if (!focusTitled) return rootKey
      const child = d.blocks[focusRootId].children[0]
      return child ? keyOf(rootKey, child) : null
    }
    return d.rootBlockIds[0] ?? null
  }

  // A structural move gives the moved rows new keys (a row's key is its
  // path). Carry the selection across: the head and anchor follow whichever
  // moved root they sit under.
  const followMoved = (moved: [from: string, to: string][]) => {
    const follow = (key: string | null) => {
      if (key === null) return key
      const hit = moved.find(([from]) => isWithin(key, from))
      return hit ? hit[1] + key.slice(hit[0].length) : key
    }
    setSelected(follow)
    setAnchorKey(follow)
  }
  // Whether the structure moves would do anything on the selection — what
  // the selection bar greys its buttons by, and what Tab and Shift+Tab check
  // first. Indent moves the selection as one: every root needs a sibling
  // above it, or nothing moves (a root left behind would have the rest nest
  // under it — under a selected row, reshaping the very selection). Outdent
  // lifts whichever roots can be lifted. The group moves need the roots to
  // be a run of siblings with room to move (`moveBlocks`).
  const selectionMoves = () => {
    const roots = structuralRoots()
    const moves = roots.map(structureMoves)
    const parentKey = roots.length > 0 ? parentKeyOf(roots[0]) : null
    const siblings =
      parentKey === null ? doc.rootBlockIds : (doc.blocks[idOfKey(parentKey)]?.children ?? [])
    const indices = roots.map((key) => siblings.indexOf(idOfKey(key)))
    const run =
      roots.length > 0 &&
      roots.every((key) => parentKeyOf(key) === parentKey) &&
      indices.every((index, k) => index !== -1 && index === indices[0] + k)
    return {
      canIndent: moves.length > 0 && moves.every((move) => move.canIndent),
      canOutdent: moves.some((move) => move.canOutdent),
      canMoveUp: run && indices[0] > 0,
      canMoveDown: run && indices[indices.length - 1] < siblings.length - 1,
    }
  }
  const indentSelection = () => {
    if (!selectionMoves().canIndent) return
    let next = doc
    const moved: [string, string][] = []
    // In document order: each row's new previous sibling is the one the group
    // is nesting under, so a contiguous sibling range nests together.
    for (const key of structuralRoots()) {
      const result = indentBlock(next, key)
      if (result.doc !== next) moved.push([key, result.key])
      next = result.doc
    }
    if (next === doc) return
    history.commit(doc, next, { type: "structural" })
    followMoved(moved)
  }
  const outdentSelection = () => {
    let next = doc
    const moved: [string, string][] = []
    // Reverse order keeps siblings in place as each is lifted out. At the focus
    // boundary, outdenting a direct child would eject it from the view — skip.
    for (const key of [...structuralRoots()].reverse()) {
      if (focusRootKey !== null && parentKeyOf(key) === focusRootKey) continue
      const result = outdentBlock(next, key)
      if (result.doc !== next) moved.push([key, result.key])
      next = result.doc
    }
    if (next === doc) return
    history.commit(doc, next, { type: "structural" })
    followMoved(moved)
  }
  // The whole contiguous selection, one position among its shared parent's
  // children (a no-op across parents).
  const moveSelection = (direction: "up" | "down") => {
    const next = moveBlocks(doc, structuralRoots(), direction)
    if (next !== doc) history.commit(doc, next, { type: "structural" })
  }
  // The selection roots copied as one group, above or below it, and the
  // copies selected.
  const duplicateSelection = (direction: "above" | "below") => {
    const result = duplicateBlocks(doc, structuralRoots(), direction)
    if (!result) return
    history.commit(doc, result.doc, { type: "structural" })
    setFocus(null)
    setAnchorKey(result.copies[0])
    setSelected(result.copies[result.copies.length - 1])
  }
  // Every selected root to one type (marker swap only — content and children
  // untouched). One structural commit = one undo step. The type is the
  // block's, so a block selected in two rows changes once. `toggle` is the
  // marker keys' way: a root already of the kind goes back to text.
  const turnSelectionInto = (target: BlockType, toggle = false) => {
    let next = doc
    for (const rootId of new Set(selectionRoots().map(idOfKey))) {
      const block = next.blocks[rootId]
      if (block) next = updateType(next, rootId, toggle ? toggleType(block.type, target) : target)
    }
    if (next !== doc) history.commit(doc, next, { type: "structural" })
  }
  const removeSelection = () => {
    let next = doc
    for (const key of structuralRoots()) {
      if (!hasOccurrence(next, key)) continue
      // The focused view's own root row: removing it would take the view with
      // it (`deleteBlock` refuses the same thing on one row, with a notice —
      // a sweep over a range that happens to include it just passes it by).
      if (focusRootId && idOfKey(key) === focusRootId) continue
      next = removeBlock(next, key).doc
    }
    if (next === doc) return
    // Select the row that visually takes the removed range's place: the first
    // surviving row below the range, falling back to the first above
    // (mirroring the single-row deleteBlock command).
    const indices = selectedKeys
      .map((key) => visibleOrder.indexOf(key))
      .filter((index) => index !== -1)
    const lo = indices.length > 0 ? Math.min(...indices) : 0
    const hi = indices.length > 0 ? Math.max(...indices) : -1
    let focusKey: string | null = null
    for (let i = hi + 1; i < visibleOrder.length && !focusKey; i++) {
      if (hasOccurrence(next, visibleOrder[i])) focusKey = visibleOrder[i]
    }
    for (let i = lo - 1; i >= 0 && !focusKey; i--) {
      if (hasOccurrence(next, visibleOrder[i])) focusKey = visibleOrder[i]
    }
    history.commit(doc, next, { type: "structural" })
    setAnchorKey(null)
    setFocus(null)
    // An emptied doc regains a blank block via the editor's trailing-blank
    // rule; an emptied focused view hands the keyboard up to its title.
    const target = focusKey ?? firstSelectable(next)
    if (target === null && focusRoot) exitTop()
    else setSelected(target)
  }

  // Serialize the selected subtrees to block markdown (markers + nesting +
  // `id::` lines) so it round-trips through paste. The ids ride only in the
  // embedded clipboard payload — where they make paste-as-link (and cut+paste
  // as a true move) possible; both visible flavors drop them.
  const markdownOfRows = (keys: string[]): string => {
    const lines: string[] = []
    const path = new Set<string>()
    const walk = (id: string, depth: number) => {
      const block = doc.blocks[id]
      if (!block) return
      const indent = "  ".repeat(depth)
      // Markers are export-only: an ordered item is written `1.` here and
      // renumbered wherever it lands (the parse side reads runs by position);
      // a code block goes as its fence.
      // A copy is a tree: a loop's closing occurrence is the block already
      // above it in the copy, so it is left out (markdown would re-mint its
      // repeated `id::` into a stray copy).
      if (path.has(id)) return
      for (const line of blockLines(block)) lines.push(indent + line)
      lines.push(`${indent}  id:: ${block.id}`)
      path.add(id)
      for (const childId of block.children) walk(childId, depth + 1)
      path.delete(id)
    }
    for (const key of keys) walk(idOfKey(key), 0)
    return lines.join("\n")
  }
  // Both flavors: clean display markdown as text/plain, plus text/html with
  // the exact block tree embedded so Ruminate→Ruminate paste round-trips.
  const copyRows = (keys: string[]) =>
    writeRichClipboard(richClipboardFormats(markdownOfRows(keys)))
  const copySelection = () => copyRows(selectionRoots())
  const cutSelection = () => {
    copySelection()
    removeSelection()
  }
  // When the caller bumps `focusFirstSignal` (e.g. Down-arrow from the note
  // title), highlight the first block — moving between the title and the blocks
  // moves the highlight, like moving between blocks.
  //
  // A signal is an edge, not a level: only a bump AFTER mount is a request.
  // An editor mounting under a counter that was bumped for an earlier
  // editor (the palette swaps its lists as the query changes) must not
  // take the keyboard from wherever it is — the query box, mid-word.
  const seenFocusFirst = useRef(focusFirstSignal)
  const seenFocusLast = useRef(focusLastSignal)
  // Down from a title — the note's above the editor, or the focus title inside
  // it — into the first row. Mirrors the title's own state: editing the title
  // drops into the first block editing (caret at its start); a highlighted
  // title just highlights it.
  const focusFirstRow = (mode: "edit" | "select") => {
    if (!navigable) return
    const first = firstSelectable(docRef.current)
    if (!first) return
    setAnchorKey(null)
    setSelected(first)
    setFocus(mode === "edit" ? { key: first, atStart: true } : null)
    // Take the keyboard now: the first row may already be the selection (it
    // is, on a fresh mount), in which case nothing above re-renders and the
    // focus-keeping effect never runs.
    if (mode !== "edit") containerRef.current?.focus({ preventScroll: true })
  }
  useEffect(() => {
    if (focusFirstSignal === seenFocusFirst.current) return
    seenFocusFirst.current = focusFirstSignal
    if (!focusFirstSignal) return
    focusFirstRow(focusFirstMode)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusFirstSignal])

  // The mirror image: `focusLastSignal` (↑ from a results list beneath this
  // one) highlights the last visible row and takes the keyboard.
  useEffect(() => {
    if (focusLastSignal === seenFocusLast.current) return
    seenFocusLast.current = focusLastSignal
    if (!focusLastSignal || !navigable) return
    const last = visibleOrder[visibleOrder.length - 1]
    if (!last) return
    setAnchorKey(null)
    setFocus(null)
    setSelected(last)
    containerRef.current?.focus({ preventScroll: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusLastSignal])

  // When the caller bumps `refocusSignal` (the global `i` shortcut), give the
  // editor keyboard focus back and restore the LAST selected row — "put me
  // back where I was" — falling back to the first selectable row.
  useEffect(() => {
    if (!refocusSignal || !navigable) return
    const last = lastSelectedRef.current
    const target =
      last && hasOccurrence(docRef.current, last) ? last : firstSelectable(docRef.current)
    if (!target) return
    setAnchorKey(null)
    setSelected(target)
    setFocus(null)
    containerRef.current?.focus({ preventScroll: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refocusSignal])

  // Enter or Cmd+Enter on a title — the note's (`newRootSignal`) or the focus
  // title's — adds a fresh root block at the top and edits it. The block is of
  // the type Enter makes (Settings → Editor, "New block markdown"), as one
  // made at the end of a block would be.
  const newRootBlock = () => {
    if (readOnly) return
    const current = docRef.current
    const type = typeOfMarker(newBlockMarker)
    // While focused, "a new root" means a new first child of the focus root —
    // the focused subtree is the page.
    const focused = focusRootId && current.blocks[focusRootId] ? focusRootId : null
    // An empty block already first (a fresh note's starter, or one just
    // added) is the new block: edit it, made that type, rather than
    // stacking another above.
    const firstId = focused ? current.blocks[focused].children[0] : current.rootBlockIds[0]
    const first = firstId ? current.blocks[firstId] : undefined
    if (
      first &&
      (first.type === "text" || first.type === type) &&
      first.text === "" &&
      first.children.length === 0
    ) {
      if (first.type !== type) {
        const retyped: BlockDoc = {
          ...current,
          blocks: { ...current.blocks, [first.id]: { ...first, type } },
        }
        history.commit(current, retyped, { type: "structural" })
      }
      const key = focused ? keyOf(focusRootKeyOf(current, focused), first.id) : first.id
      setAnchorKey(null)
      setSelected(key)
      setFocus({ key })
      return
    }
    const fresh = emptyBlock(type)
    const next: BlockDoc = focused
      ? insertFirstChild(current, focused, fresh)
      : {
          ...current,
          rootBlockIds: [fresh.id, ...current.rootBlockIds],
          blocks: { ...current.blocks, [fresh.id]: fresh },
        }
    const key = focused ? keyOf(focusRootKeyOf(current, focused), fresh.id) : fresh.id
    history.commit(current, next, { type: "structural" })
    setAnchorKey(null)
    setSelected(key)
    setFocus({ key })
  }
  useEffect(() => {
    if (newRootSignal) newRootBlock()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newRootSignal])

  // The focus title's rename: the focused block's text, one history step.
  const renameFocusRoot = (text: string): boolean => {
    const current = docRef.current
    const root = focusRootId ? current.blocks[focusRootId] : undefined
    if (!root || root.text === text) return false
    const next = updateBlock(current, root.id, { text })
    history.commit(current, next, { type: "text", blockId: root.id })
    // Enter commits the name and makes a first child in the same keystroke
    // (`newRootBlock`, before the rename has rendered): it must build on this.
    docRef.current = next
    return true
  }
  // The title is one plain line, as the note's is: a heading whose text is
  // more than that (line breaks) reads as the title but is edited in its own
  // row, outside focus. (Every other type leads the view as a row already, so it
  // never reaches the title at all — `titlesFocus`.)
  const focusTitleEditable = focusTitled && focusRoot !== null && !focusRoot.text.includes("\n")

  const edit = (key: string, atStart = false, caret?: number) => {
    if (readOnly) return
    setAnchorKey(null)
    setSelected(key)
    setFocus({ key, atStart, caret })
  }

  // After restoring a snapshot, keep editing/selecting the same row if it
  // still exists; otherwise fall back to select mode on a valid row.
  const reconcileToDoc = (restored: BlockDoc) => {
    setAnchorKey(null)
    // If a block reappeared (e.g. undo of a delete), highlight it so the thing
    // you brought back is where your focus lands.
    // Undoing or redoing mid-edit keeps you editing — on the same row where
    // it survives, else on the row that reappeared or the nearest one left —
    // so the keyboard, and the touch screen's edit bar above it, stay up.
    const wasEditing = focus !== null
    const reappeared = findReappeared(doc, restored)
    if (reappeared) {
      setFocus(wasEditing ? { key: reappeared } : null)
      setSelected(reappeared)
      return
    }
    // The selected row vanished (e.g. undoing its creation): land on its
    // nearest surviving neighbour in the CURRENT visible order — above first
    // (for an undone create that's the block Enter was pressed on), then below
    // — never jumping to the top of the file unless nothing survives.
    const nearestSurvivor = (vanished: string): string | null => {
      const at = visibleOrder.indexOf(vanished)
      if (at === -1) return null
      for (let i = at - 1; i >= 0; i--) {
        if (hasOccurrence(restored, visibleOrder[i])) return visibleOrder[i]
      }
      for (let i = at + 1; i < visibleOrder.length; i++) {
        if (hasOccurrence(restored, visibleOrder[i])) return visibleOrder[i]
      }
      return null
    }
    // A row whose key vanished but whose block is still there moved (an
    // undone indent puts it back where it was): the edit, or the highlight,
    // follows it to its new row rather than falling away — Cmd+Z after Tab
    // keeps you typing, and the edit bar's Undo keeps the bar.
    const movedTo = (key: string): string | null =>
      hasOccurrence(restored, key) ? key : firstOccurrenceKey(restored, idOfKey(key))
    const landing = (cur: string | null): string | null => {
      if (!cur) return firstSelectable(restored)
      return movedTo(cur) ?? nearestSurvivor(cur) ?? firstSelectable(restored)
    }
    setFocus((cur) => {
      if (!cur) return null
      const key = movedTo(cur.key)
      if (key !== null) return key === cur.key ? cur : { ...cur, key }
      const next = landing(cur.key)
      return next === null ? null : { key: next }
    })
    setSelected(landing)
  }

  const undo = () => {
    const restored = history.undo(doc)
    if (!restored) return false
    reconcileToDoc(restored)
    return true
  }
  const redo = () => {
    const restored = history.redo(doc)
    if (!restored) return false
    reconcileToDoc(restored)
    return true
  }

  // The occurrence just unfolded, for the render that reveals its rows:
  // that subtree's box unfolds (`Subtree`). A ref, not state, so clearing
  // it after that render costs no render of its own — on a long note every
  // render is every row. Cleared after each commit, so later rows under the
  // same key never replay it.
  const justOpened = useRef<string | null>(null)
  useEffect(() => {
    justOpened.current = null
  })

  // The rows grouped by parent, for rendering them as nested subtrees.
  const childrenOf = useMemo(() => childrenByParent(rows), [rows])
  const rowKeys = useMemo(() => new Set(visibleOrder), [visibleOrder])

  // A toggle waiting to be settled (fold-motion.ts), with where every row
  // was before it: set here, spent by the layout effect below once the
  // change has been laid out, before it is painted. The positions are
  // null when nothing slides (reduced motion); the toggle still settles,
  // so its ghost fades and goes.
  const pendingToggle = useRef<{ before: RowPositions | null } | null>(null)
  useLayoutEffect(() => {
    const pending = pendingToggle.current
    if (!pending) return
    pendingToggle.current = null
    if (containerRef.current) settleFold(containerRef.current, pending.before)
  })

  /**
   * Fold or unfold `key`. The state changes at once — `rows`, the
   * keyboard's order and the selection never wait for the motion — and the
   * motion is laid over it (fold-motion.ts): a fold leaves a ghost of the
   * subtree's box behind to be covered, an unfold reveals the returning
   * box, and the rows that moved slide. Unfolding mid-fold drops the ghost
   * at once, so the returning rows never meet it.
   */
  const toggleCollapse = (key: string) => {
    const container = containerRef.current
    if (container) pendingToggle.current = { before: measureRows(container) }
    if (collapsed.has(key)) {
      justOpened.current = key
      if (container) dropGhost(container, key)
    } else if (container) {
      const box = container.querySelector<HTMLElement>(`[data-subtree="${key}"]`)
      if (box) ghostFold(box)
    }
    if (onToggleCollapse) {
      onToggleCollapse(key)
      return
    }
    setCollapsedInternal((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  /** Drive collapse to an explicit state (paste lands its subtrees folded).
   * `toggleCollapse` is the only setter either owner of the state exposes, so
   * a row already in the wanted state is left alone rather than flipped. */
  const setCollapsedState = (key: string, shouldCollapse: boolean) => {
    if (collapsed.has(key) !== shouldCollapse) toggleCollapse(key)
  }

  // Interpret a command's result: commit any doc change to history, toggle
  // collapse, and move focus/selection where the command asked.
  // Leaving the rows upward: the highlight clears below while focus moves up
  // to the title — the focus title here, or whatever the page put above the
  // editor (the note title).
  const exitTop = () => {
    // Nothing above the rows to hand the keyboard to — a focus whose root is
    // its first row, on a page with no note title of its own (a daily note,
    // or a focused one, where the breadcrumb carries the name instead). The
    // top row keeps it rather than the highlight falling away.
    if (!focusTitled && !onExitTop) return
    setFocus(null)
    setSelected(null)
    setAnchorKey(null)
    if (focusTitled) setFocusTitleSignal((n) => n + 1)
    else onExitTop?.()
  }
  const applyFocus = (intent: FocusIntent) => {
    // Any single-target command collapses a multi-row selection.
    setAnchorKey(null)
    // In focus, a target outside the view (the focused block itself, or a root
    // the view does not show — where a delete falls back to) is the title —
    // or, where there is none, the view's own root row.
    if (intent.key !== null && focusRootKey && !isWithin(intent.key, focusRootKey)) {
      if (focusTitled) exitTop()
      else {
        setFocus(null)
        setSelected(focusRootKey)
      }
      return
    }
    if (intent.mode === "select") {
      setFocus(null)
      setSelected(intent.key)
    } else {
      setSelected(intent.key)
      setFocus({ key: intent.key, atStart: intent.atStart, caret: intent.caret })
    }
  }
  const applyResult = (result: CommandResult) => {
    if (result.doc) history.commit(doc, result.doc, result.op ?? { type: "structural" })
    // Commands name rows, and folds are per row.
    if (result.toggleCollapse) toggleCollapse(result.toggleCollapse)
    // `expand` is a demand ("this row must be open"), not a toggle: only act
    // when the row is actually collapsed (commands can't see collapse state).
    if (result.expand) setCollapsedState(result.expand, false)
    // `collapse` is the symmetric demand ("this row must be closed"): only
    // act when the row is actually open.
    if (result.collapse) setCollapsedState(result.collapse, true)
    // `reveal` is the unconditional one: the row is about to become a parent,
    // so it is not folded *yet* and the two demands above would both find
    // nothing to do. Recorded as the reader's own open, which is what keeps
    // the depth rule from closing it around the row just nested into it.
    if (result.reveal) {
      if (onReveal) onReveal(result.reveal)
      else setCollapsedState(result.reveal, false)
    }
    if (result.focus) applyFocus(result.focus)
    // A change of focus root navigates (URL state); the focus-change effect
    // then places the selection (the focused block, or its first child under a
    // title, on the way in; the block left behind on the way out).
    if (result.focusRoot !== undefined) navigateFocus(result.focusRoot.id)
    if (result.notice) toast(result.notice)
    if (result.exitTop) exitTop()
    // Leaving the bottom is the same, downward — only where there is
    // something below to take the keyboard; otherwise the key is consumed
    // and the last row stays highlighted.
    if (result.exitBottom && onExitBottom) {
      setFocus(null)
      setSelected(null)
      setAnchorKey(null)
      onExitBottom()
    }
  }

  // The single entry point every keyboard handler funnels through: resolve the
  // event to a command via the keymap and run it. Touch/menu entry points would
  // dispatch the same commands. Returns whether the gesture was consumed.
  const dispatchKey = (mode: Mode, key: string, event: KeyLike, caret?: CaretInput): boolean => {
    if (!navigable) return false
    const input: CommandInput = {
      doc,
      key,
      mode,
      visibleOrder,
      caret,
      // Which character the key types, for the one command that depends on it
      // (`wrapTyped`); every other command reads the resolved name alone.
      typed: event.key,
      focusRootId,
      focusTitled,
      focusBackId,
      rootId: noteId ?? null,
      newBlockType: typeOfMarker(newBlockMarker),
      placesOf: parentCountOf,
      emptyable,
    }
    const name = resolveKey(mode, event, input)
    if (!name) return false
    if (readOnly) {
      // Browsing: Enter opens the row where it would have edited it (or
      // does nothing, where there is nowhere to go), and only what moves,
      // folds or changes the focus runs — nothing that writes.
      if (name === "enterEdit") {
        onActivate?.(idOfKey(key))
        return true
      }
      if (!BROWSE_COMMANDS.has(name)) return false
    }
    const result = runCommand(name, input)
    applyResult(result)
    return result.handled
  }
  // Run a command by name on a row — what the context menu does, so a menu
  // item and its key do exactly the same thing.
  const runOnRow = (name: CommandName, key: string, mode: Mode = "select", caret?: CaretInput) => {
    if (readOnly) return
    applyResult(
      runCommand(name, {
        doc,
        key,
        mode,
        visibleOrder,
        caret,
        focusRootId,
        focusTitled,
        focusBackId,
        rootId: noteId ?? null,
        newBlockType: typeOfMarker(newBlockMarker),
        placesOf: parentCountOf,
        emptyable,
      }),
    )
  }
  // Whether the structure moves would do anything on a row — what the edit
  // bar greys its Outdent and Indent by. Indent needs a sibling above (the
  // row nests under it); Outdent a parent that is not the focus root (its
  // children cannot leave the view).
  const structureMoves = (key: string): { canIndent: boolean; canOutdent: boolean } => {
    const parentKey = parentKeyOf(key)
    const siblings =
      parentKey === null ? doc.rootBlockIds : (doc.blocks[idOfKey(parentKey)]?.children ?? [])
    const canIndent = siblings.indexOf(idOfKey(key)) > 0
    const canOutdent =
      parentKey !== null && (focusRootId === null || idOfKey(parentKey) !== focusRootId)
    return { canIndent, canOutdent }
  }
  // Run a command on the row being edited, in edit mode with its caret —
  // what the touch screen's edit bar does, so its Indent is Tab's: the
  // caret stays where it was on the row's new key.
  const runOnEditing = (name: CommandName) => {
    if (!focus) return
    const el = containerRef.current?.querySelector("textarea")
    const caret: CaretInput | undefined = el
      ? {
          value: el.value,
          start: el.selectionStart,
          end: el.selectionEnd,
          atFirstLine: false,
          atLastLine: false,
        }
      : undefined
    runOnRow(name, focus.key, "edit", caret)
  }

  // ── The context menu ──────────────────────────────────────────────────────
  // A right-click on a row opens the block menu on that row (and selects it,
  // so the keyboard follows). Empty space beneath the rows gets the browser's
  // own menu: the event is stopped before the menu's trigger sees it.
  const [menuTarget, setMenuTarget] = useState<BlockMenuTarget | null>(null)
  // A touch screen's highlight has no keyboard to serve: once an edit ends
  // (the keyboard put away, a delete, a swap of rows), nothing stays lit —
  // unless the block menu is open on the row, which the highlight names.
  useEffect(() => {
    if (!coarse || focus !== null || menuTarget !== null) return
    setSelected(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coarse, focus, menuTarget])

  /** The menu target for the row an element sits in, or null off the rows. */
  const menuTargetAt = (el: EventTarget | null): BlockMenuTarget | null => {
    if (!(el instanceof Element)) return null
    const key = el.closest<HTMLElement>("[data-occurrence]")?.dataset.occurrence
    const row = key === undefined ? undefined : rows.find((r) => r.key === key)
    const block = row ? doc.blocks[row.id] : undefined
    if (!row || !block) return null
    return {
      key: row.key,
      id: row.id,
      type: block.type,
      hasChildren: row.hasChildren,
      places: parentCountOf ? Math.max(1, parentCountOf(row.id)) : 1,
      pinned: pinnedRoots.has(block.id),
      figure: isFigureType(block.type)
        ? { align: figureAlignOf(block), sized: figureLayoutOf(block).size !== undefined }
        : undefined,
      links:
        block.type === "link"
          ? [{ href: linkPropsOf(block).url, title: block.text }].filter((l) => l.href !== "")
          : block.type === "code"
            ? []
            : linksInText(block.text),
    }
  }
  const openMenuOn = (target: BlockMenuTarget) => {
    setMenuTarget(target)
    // Editing a different row would otherwise keep its textarea focused
    // under the menu; the menu's row becomes the selection.
    if (!selectedSet.has(target.key)) select(target.key)
  }
  // A right-click: the `contextmenu` event reaches here (capture) before the
  // menu's trigger opens on it, so the target is set by the time it shows.
  // Stopping the event here keeps it from the trigger altogether (its own
  // handler, and the document listener it cancels the browser's menu with),
  // so the browser's menu shows instead: off the rows, and inside the
  // textarea being typed in, where that menu carries the spelling
  // suggestions for a marked word and a text field's cut/copy/paste. The
  // block's menu still opens on the rest of the row (its marker, the
  // margin), and on the whole row once it is not being edited.
  const handleContextMenuCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (readOnly) return
    if (event.target instanceof HTMLTextAreaElement) {
      event.stopPropagation()
      return
    }
    const target = menuTargetAt(event.target)
    if (!target) {
      event.stopPropagation()
      return
    }
    if (coarse) {
      // Android's long press arrives as a contextmenu: the sheet, and never
      // the browser's own menu.
      event.preventDefault()
      event.stopPropagation()
      cancelPress()
      lockPage(true)
      setHolding(true)
      openMenuOn(target)
      setSheetOpen(true)
      return
    }
    openMenuOn(target)
  }
  // A touch long-press: the menu opens itself (no `contextmenu` event on a
  // phone), and says what was pressed; a press off the rows opens nothing.
  const handleMenuOpenChange = (open: boolean, event: Event | undefined) => {
    if (!open) {
      heldOpen.current = false
      return
    }
    if (readOnly) return
    const pressed = event?.target ?? null
    const target = menuTargetAt(pressed)
    if (target) {
      if (target.key !== menuTarget?.key) openMenuOn(target)
      heldOpen.current = event?.type.startsWith("touch") ?? false
    } else if (pressed) {
      setMenuTarget(null)
    }
  }
  // A phone's press-and-hold opens the menu while the finger is still down.
  // When it lifts, iOS fires the click it owed the row — onto whatever is
  // under the finger by then, which may well be a menu item. Consuming that
  // `touchend` is the one thing that withholds the click.
  const heldOpen = useRef(false)
  const handleTouchEndCapture = (event: TouchEvent<HTMLDivElement>) => {
    if (!heldOpen.current) return
    heldOpen.current = false
    if (event.cancelable) event.preventDefault()
  }
  // On a touch screen the menu is a sheet from the bottom (`BlockMenuSheet`),
  // opened by a press-and-hold the editor times itself: a finger down on a
  // row that stays put for 450ms, and has not lifted. A popup anchored under
  // the finger was fragile — it opened as the press registered and shut on
  // the lift, or on the scroll the same finger began — where a sheet holds
  // still and is dismissed on purpose. The popup's own press detection is
  // not mounted on a touch screen at all.
  const [sheetOpen, setSheetOpen] = useState(false)
  const press = useRef<{ timer: number; x: number; y: number } | null>(null)
  const cancelPress = () => {
    if (press.current !== null) {
      window.clearTimeout(press.current.timer)
      press.current = null
    }
    if (!holdingRef.current) lockPage(false)
  }
  // While a finger is down on a row, nothing on the page may be selected:
  // not the text behind the sheet, not the sheet rising under the finger,
  // not the page itself (iOS's long press, left to itself, selects whatever
  // the finger is over once the sheet is there — at worst the whole screen).
  // The lock is a class on the root (`block-editor.css`), taken on the
  // finger's down and given back on its lift.
  const lockPage = (on: boolean) => document.documentElement.classList.toggle("press-hold", on)
  // The sheet opens while the finger that asked for it is still down, and
  // the lift that follows is not a pick: the sheet's rows ignore it (and
  // the click the browser owes it) until a beat after the finger is up.
  // Listened to on the document, since the sheet is portalled out of the
  // editor and the row the finger went down on may have re-rendered away.
  const [holding, setHoldingState] = useState(false)
  const holdingRef = useRef(false)
  const setHolding = (on: boolean) => {
    holdingRef.current = on
    setHoldingState(on)
    if (!on) lockPage(false)
  }
  useEffect(() => {
    if (!holding) return
    let timer: number | undefined
    const lift = (event: Event) => {
      if ((event as PointerEvent).pointerType === "mouse") return
      if (event.type === "touchend" && event.cancelable) event.preventDefault()
      if (timer === undefined) timer = window.setTimeout(() => setHolding(false), LIFT_GRACE)
    }
    for (const type of LIFT_EVENTS) {
      document.addEventListener(type, lift, { capture: true, passive: false })
    }
    return () => {
      for (const type of LIFT_EVENTS) document.removeEventListener(type, lift, true)
      window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setHolding is stable in what it does
  }, [holding])
  // A text selection the page is showing is dropped by a finger on the
  // editor: the rows are unselectable under a finger (the container's
  // `select-none`), so a selection is never one the person meant — it is
  // what a press-and-hold left on some text outside the rows, or on a
  // build before the rows were unselectable — and with nothing selectable
  // to tap, iOS offers no way to be rid of it. A field's own selection (the
  // textarea being edited) is the person's, and stays.
  const dropPageSelection = () => {
    const active = document.activeElement
    if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) return
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed) selection.removeAllRanges()
  }
  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!coarse || readOnly || event.pointerType === "mouse") return
    dropPageSelection()
    // A hold in the text being edited is the person selecting some of it
    // (to format it, to copy it): iOS's own selection, and no sheet.
    if (event.target instanceof HTMLTextAreaElement) return
    const target = menuTargetAt(event.target)
    if (!target) return
    cancelPress()
    lockPage(true)
    const { clientX: x, clientY: y } = event
    press.current = {
      x,
      y,
      timer: window.setTimeout(() => {
        press.current = null
        setHolding(true)
        dropPageSelection()
        openMenuOn(target)
        setSheetOpen(true)
        // A nudge where the device offers one (Android; iOS has no web API).
        navigator.vibrate?.(10)
      }, 450),
    }
  }
  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const p = press.current
    if (p && Math.hypot(event.clientX - p.x, event.clientY - p.y) > 8) cancelPress()
  }
  const closeSheet = () => {
    setSheetOpen(false)
    setMenuTarget(null)
  }
  useEffect(
    () => () => {
      cancelPress()
      lockPage(false)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on unmount only
    [],
  )
  // ── Images ────────────────────────────────────────────────────────────────
  // A pasted, dropped or picked picture is uploaded first and only then
  // becomes a block (a failed upload leaves the doc as it was and says so),
  // landing after the row it was given to — or replacing that row when it is
  // an empty paragraph/bullet, so "/image" on a blank line puts the picture
  // on that line. Several files arrive in order, each its own undo step.
  const [lightbox, setLightbox] = useState<string | null>(null)
  /**
   * Put pictures in, then send them up.
   *
   * The rows land first, each drawing the file the reader already has
   * (`beginPendingImage`), so a pasted screenshot is on screen at once
   * instead of after the round trip. Nothing provisional reaches the graph:
   * the block carries no image props until its asset id arrives, and the
   * preview lives only in memory. When the upload lands the id is written
   * WITHOUT a history step, so the picture is still one undo; when it fails
   * the row is taken back out and a toast says why.
   */
  const insertImages = async (key: string, files: File[]) => {
    if (!onImageUpload) return
    // Chained locally, so a second picture lands after the first even before
    // the host has re-rendered with the first one in.
    let current = docRef.current
    const queued: { id: string; key: string; file: File; restore: Block | null }[] = []
    for (const file of files) {
      const targetId = idOfKey(key)
      const target = current.blocks[targetId]
      if (!target) break
      const blank =
        (target.type === "text" || target.type === "ul") &&
        target.text === "" &&
        target.children.length === 0
      let next: BlockDoc
      let nextKey: string
      let imageId: string
      let restore: Block | null
      if (blank) {
        // The picture takes the blank line over; failure puts it back.
        imageId = targetId
        restore = target
        next = {
          ...current,
          blocks: {
            ...current.blocks,
            [targetId]: { ...target, type: "image", text: "", props: undefined },
          },
        }
        nextKey = key
      } else {
        const image: Block = { id: blockId(), type: "image", text: "", children: [] }
        imageId = image.id
        restore = null
        next = insertAfter(current, key, image)
        nextKey = keyOf(parentKeyOf(key), image.id)
      }
      beginPendingImage(imageId, file)
      history.commit(current, next, { type: "structural" })
      current = next
      docRef.current = next
      setAnchorKey(null)
      setFocus(null)
      setSelected(nextKey)
      key = nextKey
      queued.push({ id: imageId, key: nextKey, file, restore })
    }

    for (const { id, key: rowKey, file, restore } of queued) {
      try {
        const asset = await onImageUpload(file)
        // The bytes are already in hand — draw them rather than fetching the
        // picture straight back down.
        primeImageObjectUrl(asset.id, file)
        const doc = docRef.current
        const block = doc.blocks[id]
        if (!block) continue
        const next: BlockDoc = {
          ...doc,
          blocks: {
            ...doc.blocks,
            [id]: {
              ...block,
              props: {
                image: asset.id,
                ...(asset.width && asset.height
                  ? { width: asset.width, height: asset.height }
                  : {}),
                ...(asset.thumbhash ? { thumbhash: asset.thumbhash } : {}),
              },
            },
          },
        }
        // Not a history step: finishing the upload is the same edit as making
        // the row, so one undo still takes the whole picture back out.
        docRef.current = next
        onChange(next)
      } catch (error) {
        const doc = docRef.current
        let next: BlockDoc | null = null
        if (restore) {
          const block = doc.blocks[id]
          if (block) next = { ...doc, blocks: { ...doc.blocks, [id]: restore } }
        } else if (doc.blocks[id] && idOfKey(rowKey) === id) {
          next = removeBlock(doc, rowKey).doc
        }
        if (next) {
          docRef.current = next
          onChange(next)
        }
        toast.error(error instanceof ImageUploadError ? error.message : "Image upload failed")
      } finally {
        releasePendingImage(id)
      }
    }
  }
  const imageInputRef = useRef<HTMLInputElement>(null)
  const imageInputKey = useRef<string | null>(null)
  const requestImage = (key: string) => {
    imageInputKey.current = key
    imageInputRef.current?.click()
  }
  const handleImagePicked = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ""
    const key = imageInputKey.current
    imageInputKey.current = null
    if (key && files.length > 0) void insertImages(key, files)
  }
  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!onImageUpload || readOnly) return
    if (Array.from(event.dataTransfer.types).includes("Files")) event.preventDefault()
  }
  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!onImageUpload || readOnly) return
    const files = imageFilesOf(event.dataTransfer)
    if (files.length === 0) return
    event.preventDefault()
    const rowEl = (event.target as HTMLElement).closest<HTMLElement>("[data-occurrence]")
    const key = rowEl?.dataset.occurrence ?? rows[rows.length - 1]?.key
    if (key) void insertImages(key, files)
  }

  /** Write a figure block's layout (`src/blocks/figure.ts`) as one undo step. */
  const setFigureLayout = (id: string, layout: { align?: FigureAlign; size?: number | null }) => {
    const block = doc.blocks[id]
    if (!block || !isFigureType(block.type)) return
    const next = updateBlock(doc, id, { props: withFigureLayout(block, layout) })
    if (next !== doc) history.commit(doc, next, { type: "structural" })
  }

  // ── Links ─────────────────────────────────────────────────────────────────
  // A link in a row's text becomes a link block (docs/links.md) from its
  // hover card. The block is made at once, with the address and the link's
  // text for a title; its preview — what the page says about itself — is
  // fetched behind it and written on without a history step, so the whole
  // block is one undo, as a picture's upload is. A page that will not
  // answer leaves the card with its address alone and says so in a toast:
  // the block is still there to open, and Refresh preview asks again.
  /**
   * Fetch `url`'s preview and write it onto block `id`. An untitled block
   * takes the page's title; a titled one keeps its own. Not a history
   * step. Failure is said in a toast, with the page's host and why.
   */
  const previewInto = async (id: string, url: string) => {
    if (!onLinkPreview) return
    try {
      const preview = await onLinkPreview(url)
      const current = docRef.current
      const block = current.blocks[id]
      if (!block || block.type !== "link" || linkPropsOf(block).url !== url) return
      const next: BlockDoc = {
        ...current,
        blocks: {
          ...current.blocks,
          [id]: {
            ...block,
            text: block.text.trim() === "" && preview.title ? preview.title : block.text,
            props: withLinkPreview(block, preview),
          },
        },
      }
      docRef.current = next
      onChange(next)
    } catch (error) {
      const why = error instanceof LinkPreviewError ? error.message : "Preview failed"
      toast.error(`No preview for ${hostOf(url)}: ${why.charAt(0).toLowerCase()}${why.slice(1)}`)
    }
  }
  /**
   * The link block for the link `href` (titled `title`) in row `key`: the
   * row itself becomes the block when its text is nothing but the link — a
   * pasted address, a `[title](url)` on its own — and otherwise a new row
   * goes in beneath it, so the sentence keeps its link. The new or changed
   * row is selected; its preview is fetched behind it.
   */
  const linkToBlock = (key: string, href: string, title: string) => {
    const current = docRef.current
    const targetId = idOfKey(key)
    const target = current.blocks[targetId]
    if (!target) return
    const whole = wholeTextLink(target.text)
    const inPlace = whole !== null && whole.url === href && target.type !== "note"
    const text = (inPlace ? whole.title : title).trim()
    let next: BlockDoc
    let id: string
    let nextKey: string
    if (inPlace) {
      id = targetId
      nextKey = key
      next = {
        ...current,
        blocks: {
          ...current.blocks,
          [id]: { ...target, type: "link", text, props: { url: href } },
        },
      }
    } else {
      const link: Block = { id: blockId(), type: "link", text, props: { url: href }, children: [] }
      id = link.id
      next = insertAfter(current, key, link)
      nextKey = keyOf(parentKeyOf(key), link.id)
    }
    history.commit(current, next, { type: "structural" })
    docRef.current = next
    setAnchorKey(null)
    setFocus(null)
    setSelected(nextKey)
    void previewInto(id, href)
  }
  /** Fetch a link block's preview again, and say so if the page will not. */
  const refreshPreview = (id: string) => {
    const block = doc.blocks[id]
    if (!block || block.type !== "link") return
    const { url } = linkPropsOf(block)
    if (url) void previewInto(id, url)
  }
  /**
   * A link block's title and/or address, changed in one step. A new
   * address takes the old preview with it (it was the old page's) and has
   * the new page's fetched behind; a scheme-less one is taken as https,
   * and anything not a web address is refused. The layout is kept (and the
   * pin needs no keeping: it is a view of the block's id, which stays).
   */
  const updateLinkBlock = (id: string, next: { href?: string; title?: string }) => {
    const block = doc.blocks[id]
    if (!block || block.type !== "link") return
    const { url } = linkPropsOf(block)
    const target = next.href === undefined ? url : hrefOf(next.href.trim())
    if (!isWebUrl(target)) return
    const title = next.title?.trim()
    const text = title !== undefined && title !== "" ? title : block.text
    const moved = target !== url
    const patch: BlockPatch = { text }
    if (moved) {
      const { align, size } = figureLayoutOf(block)
      patch.props = {
        url: target,
        ...(align ? { align } : {}),
        ...(size !== undefined ? { size } : {}),
      }
    }
    const updated = updateBlock(doc, id, patch)
    if (updated === doc) return
    history.commit(doc, updated, { type: "structural" })
    // The fetch may land before the host has re-rendered with the change;
    // the ref it reads the block through must already hold it.
    docRef.current = updated
    if (moved) void previewInto(id, target)
  }
  /** A link block back to a paragraph holding its link as text. */
  const linkToInline = (id: string) => {
    const block = doc.blocks[id]
    if (!block || block.type !== "link") return
    const { url } = linkPropsOf(block)
    const next = updateBlock(doc, id, {
      type: "text",
      text: url ? `[${block.text}](${url})` : block.text,
      props: null,
    })
    if (next !== doc) history.commit(doc, next, { type: "structural" })
  }

  // A block is the user's own to share when the editor has a note of theirs
  // behind it: signed in, and not a note someone shared with them.
  const isDatabaseMode = useAtomValue(isDatabaseModeAtom)
  const sharedOrigin = useAtomValue(sharedOriginAtom)
  const openShareDialog = useSetAtom(shareDialogAtom)
  const sharingEnabled = useFeature("sharing")
  const canShare =
    noteId !== undefined && isDatabaseMode && sharingEnabled && !sharedOrigin.has(noteId)
  // A block can be pinned wherever the editor has a note behind it — signed
  // out too, where the sample notes are there to play with, and in a note
  // someone shared: the pin is a view of this user's own
  // (`src/data/views.ts`), not a prop on the owner's row. It is not a
  // change to the doc, so it is not an undo step either.
  const canPin = noteId !== undefined
  const pinnedRoots = useAtomValue(pinnedRootIdsAtom)
  const writeView = useWriteView()
  const togglePin = (id: string) => writeView(id, { pinned: !pinnedRoots.has(id) })

  // ── Links ─────────────────────────────────────────────────────────────────
  // Leaving a row's edit mode writes out any bare address in it as a link
  // named for its host (docs/links.md), as a space typed after one does
  // and a paste does — so an address typed and left by Escape, a click
  // elsewhere or Enter reads as a name too. Its own undo step, so the bare
  // address is one ⌘Z away. Never in a code block.
  const lastEdited = useRef<string | null>(null)
  useEffect(() => {
    const previous = lastEdited.current
    lastEdited.current = focus?.key ?? null
    if (previous === null || previous === focus?.key || readOnly) return
    const current = docRef.current
    const block = current.blocks[idOfKey(previous)]
    if (!block || block.type === "code" || block.type === "note") return
    const text = linkifyPastedText(block.text)
    if (text === block.text) return
    history.commit(current, updateBlock(current, block.id, { text }), { type: "structural" })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus])
  /** The link card the menu asked to open (a touch screen's "Edit link"):
   * the row and the address; the row's rendered link opens its card. */
  const [linkCard, setLinkCard] = useState<{ key: string; href: string } | null>(null)

  /**
   * A link's display text and/or address, changed in the row's text
   * (docs/links.md) in one rewrite: `[title](href)` becomes
   * `[next.title](next.href)`. A link that was a bare address, or an
   * autolink written another way, is found by its address or its text and
   * written out as a link; a new address without a scheme is taken as
   * https, and anything not a web address is refused. The first
   * occurrence is the one changed; one undo step.
   */
  const updateLink = (
    key: string,
    href: string,
    title: string,
    next: { href?: string; title?: string },
  ) => {
    const target = next.href === undefined ? href : hrefOf(next.href.trim())
    if (!isWebUrl(target)) return
    const typed = next.title?.trim()
    const display =
      typed !== undefined && typed !== ""
        ? typed
        : title === "" || title === href
          ? hostOf(target)
          : title
    rewriteLink(key, href, title, `[${display}](${target})`)
  }
  /** A link taken off: `[title](href)` becomes `title`; a bare address
   * stays as it is (there is nothing to take off it). */
  const removeLink = (key: string, href: string, title: string) => {
    if (title !== "" && title !== href) rewriteLink(key, href, title, title)
  }
  /** The first occurrence of the link in the row's text — written out, an
   * autolink, a bare address, or its text — replaced by `replacement`. One
   * undo step. */
  const rewriteLink = (key: string, href: string, title: string, replacement: string) => {
    const block = doc.blocks[idOfKey(key)]
    if (!block) return
    let text: string | null = null
    for (const needle of [`[${title}](${href})`, `<${href}>`, href, title]) {
      if (needle !== "" && block.text.includes(needle)) {
        text = block.text.replace(needle, replacement)
        break
      }
    }
    if (text === null || text === block.text) return
    const updated = updateBlock(doc, block.id, { text })
    history.commit(doc, updated, { type: "structural" })
  }

  const setBlockType = (id: string, type: BlockType) => {
    const next = updateBlock(doc, id, { type })
    if (next !== doc) history.commit(doc, next, { type: "structural" })
  }
  const menuActions: BlockMenuActions = {
    editLink: (key, href) => setLinkCard({ key, href }),
    turnIntoLink: (key, href, title) => linkToBlock(key, href, title === href ? "" : title),
    openImage: (id) => setLightbox(id),
    downloadImage: (id) => {
      const block = doc.blocks[id]
      if (block) void downloadImage(block)
    },
    openLink: (id) => {
      const block = doc.blocks[id]
      const url = block ? linkPropsOf(block).url : ""
      if (url) openLink(url)
    },
    refreshPreview: onLinkPreview ? refreshPreview : undefined,
    linkToInline,
    alignFigure: (id, align) => setFigureLayout(id, { align }),
    resetFigureSize: (id) => setFigureLayout(id, { size: null }),
    duplicate: (key) => runOnRow("duplicateBelow", key),
    moveUp: (key) => runOnRow("moveBlockUp", key),
    moveDown: (key) => runOnRow("moveBlockDown", key),
    copy: (key) => copyRows([key]),
    copyLink: noteId
      ? (id) => copy(`${window.location.origin}/notes/${noteId}?block=${id}`)
      : undefined,
    pin: canPin ? togglePin : undefined,
    share: canShare ? (id) => openShareDialog(id) : undefined,
    remove: (key) => runOnRow("deleteBlock", key),
    deleteEverywhere: onDeleteEverywhere,
    deleteSubtree: onDeleteSubtree,
  }

  /**
   * The view, as nested subtrees: each row, then — when it has rows beneath
   * it — its `Subtree` holding them, rendered the same way. The DOM order
   * is the flat view's (depth first).
   */
  const renderRows = (list: readonly Occurrence[]): React.ReactNode =>
    list.map((row) => {
      const block = doc.blocks[row.id]
      if (!block) return null
      const kids = childrenOf.get(row.key)
      return (
        <Fragment key={row.key}>
          <BlockItem doc={doc} block={block} occurrence={row} api={api} />
          {kids && kids.length > 0 ? (
            <Subtree parentKey={row.key} opening={justOpened.current === row.key}>
              {renderRows(kids)}
            </Subtree>
          ) : null}
        </Fragment>
      )
    })

  const api: BlockEditorApi = {
    debug,
    onImageFiles:
      onImageUpload && !readOnly ? (key, files) => void insertImages(key, files) : undefined,
    requestImage: onImageUpload && !readOnly ? requestImage : undefined,
    openImage: (id) => setLightbox(id),
    linkToBlock: readOnly ? undefined : linkToBlock,
    updateLink: readOnly ? undefined : updateLink,
    linkToInline: readOnly ? undefined : linkToInline,
    updateLinkBlock: readOnly ? undefined : updateLinkBlock,
    removeLinkBlock: readOnly ? undefined : (key) => runOnRow("deleteBlock", key),
    removeLink: readOnly ? undefined : removeLink,
    linkCard,
    closeLinkCard: () => setLinkCard(null),
    focus,
    selected,
    selectedSet,
    selectionRunEdges,
    readOnly,
    navigable,
    // Inert read-only views never take keyboard focus, but their highlights
    // are plain display state — never demote them to "inactive". The rest
    // own the keyboard when focus is inside AND the last thing the user did
    // was not click on blank space (`pointerIdle`).
    // A touch screen has no keyboard cursor to claim: its highlight is
    // always the quiet one, and only while a menu is open on the row.
    keyboardActive: !navigable || (keyboardActive && !pointerIdle && !coarse),
    coarsePointer: coarse,
    fixedRoots,
    context,
    // Browsing: a click opens the row (BlockItem routes a read-only row's
    // click here).
    activate: readOnly && onActivate ? (key) => onActivate(idOfKey(key)) : undefined,
    select,
    edit,
    toggleCollapse,
    setFocus,
    onBlockChange: (id, patch, op = "text") => {
      const next = updateBlock(doc, id, patch)
      if (next === doc) return
      history.commit(
        doc,
        next,
        op === "structural" ? { type: "structural" } : { type: "text", blockId: id },
      )
    },
    onPaste: (key, before, pasted, after) => {
      // Re-form the block's text with the pasted text spliced in at the caret,
      // then parse (import) the whole thing so markdown markers and blank
      // lines become the right blocks. The current block keeps its type —
      // unless the caret sits at the start and the pasted content opens with
      // its own marker, in which case the paste defines the block type (so
      // pasting "# Title" into a heading is a heading, not a heading whose
      // text starts with a literal "#").
      const pastedFirstLine = pasted.slice(
        0,
        pasted.includes("\n") ? pasted.indexOf("\n") : undefined,
      )
      const pasteDefinesType = before === "" && leadingMarker(pastedFirstLine) !== null
      // Reminting keeps a pasted `id::` from clobbering an existing block.
      let sub = remintCollidingIds(parse(before + pasted + after), doc)
      const currentType = doc.blocks[idOfKey(key)]?.type
      if (!pasteDefinesType && currentType !== undefined && sub.rootBlockIds.length > 0) {
        sub = updateType(sub, sub.rootBlockIds[0], currentType)
      }
      const result = spliceBlocks(doc, key, sub)
      if (!result) return
      history.commit(doc, result.doc, { type: "structural" })
      // Place the caret at the paste boundary — just before the trailing text.
      const last = result.doc.blocks[result.lastId]
      const caret = Math.max(0, last.text.length - after.length)
      // The pasted blocks took the row's place among its siblings.
      const lastKey = keyOf(parentKeyOf(key), result.lastId)
      setSelected(lastKey)
      setFocus({ key: lastKey, caret })
    },
    dispatchKey,
    startSelectionLadder: (key) => {
      if (readOnly) return
      // Called from edit mode (Cmd/Ctrl+A with the textarea already fully
      // selected): leave edit mode and take the first ladder rung on the row.
      setFocus(null)
      setSelected(key)
      setAnchorKey(null)
      focusContainer()
      escalateFrom([key], { selected: key, anchorKey: null })
    },
  }

  // Undo and redo from anywhere on the page that is not itself editable — the
  // basket's summary after an unlink, the sidebar, the empty space below the
  // rows — reach the editor last focused, so glancing away does not strand
  // the undo. Inside an input, a dialog, a menu or another block editor the
  // keys are theirs.
  const latestHistory = useRef({ undo, redo })
  latestHistory.current = { undo, redo }
  useEffect(() => {
    if (readOnly) return
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.defaultPrevented) return
      const key = event.key.toLowerCase()
      const isUndo = key === "z" && !event.shiftKey
      const isRedo = (key === "z" && event.shiftKey) || key === "y"
      if (!isUndo && !isRedo) return
      const root = containerRef.current
      if (!root || lastActiveEditor !== root) return
      const target = event.target
      if (!(target instanceof Element) || root.contains(target)) return
      if (target.closest(UNDO_KEEPS_TO_ITSELF)) return
      if (isUndo ? latestHistory.current.undo() : latestHistory.current.redo()) {
        event.preventDefault()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [readOnly])

  // The arrow keys always come back to the editor. A click on a button or a
  // nav link leaves focus there, where Up/Down mean nothing, and the user's
  // selection is still sitting in the editor waiting for them; so an Up or
  // Down (plain or with Shift) pressed on such a control refocuses the
  // container and is replayed there, so the same keystroke also moves the
  // selection from where it was — or, with nothing selected, lands on the
  // first/last block as the container's own handler does. The same
  // exclusions as ⌘Z: anything that uses arrows itself (form fields, dialogs,
  // menus, lists, other editors) keeps them. The replay is a fresh event on
  // the container; the original is cancelled so the control never sees it.
  useEffect(() => {
    if (!navigable) return
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return
      const root = containerRef.current
      if (!root || lastActiveEditor !== root) return
      const target = event.target
      if (!(target instanceof Element) || root.contains(target)) return
      if (target.closest(ARROWS_KEEP_TO_THEMSELVES)) return
      event.preventDefault()
      root.focus({ preventScroll: true })
      root.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: event.key,
          shiftKey: event.shiftKey,
          bubbles: true,
          cancelable: true,
        }),
      )
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [navigable])

  // The container is the single keyboard target for select mode (see the focus
  // effect below). Edit mode is handled by the focused textarea inside the
  // block; those events also bubble here, so we bail while editing.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Any real key (not a bare modifier) hands the selection back to the
    // keyboard after a click on blank space — see `pointerIdle`.
    if (!MODIFIER_KEYS.has(event.key)) setPointerIdle(false)

    // Cmd/Ctrl+Z undoes, Cmd/Ctrl+Shift+Z (or Ctrl+Y) redoes — at the document
    // level, so a single keystroke can walk back changes across many blocks.
    if (event.metaKey || event.ctrlKey) {
      const key = event.key.toLowerCase()
      if (key === "z" && !event.shiftKey) {
        if (undo()) event.preventDefault()
        return
      }
      if ((key === "z" && event.shiftKey) || key === "y") {
        if (redo()) event.preventDefault()
        return
      }
      // other Cmd combos (Cmd+Enter, Cmd+Arrow, Cmd+C/X) fall through below
    }

    // Nothing focused (after Escape's deselect): arrows re-select the first /
    // last visible block, so the editor stays reachable by keyboard.
    if (!focus && !selected && !event.defaultPrevented) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const target =
          event.key === "ArrowDown" ? visibleOrder[0] : visibleOrder[visibleOrder.length - 1]
        if (target) {
          event.preventDefault()
          setAnchorKey(null)
          setSelected(target)
        }
      }
      return
    }

    // Edit mode: the textarea's own handler owns the keys; don't double-handle.
    if (focus || !selected || event.defaultPrevented) return
    const key = selected
    const mod = event.metaKey || event.ctrlKey

    // Shift+Arrow grows / shrinks a multi-block selection — but NOT with Cmd/Ctrl
    // (move-block) or Alt (duplicate) also held; those resolve via the keymap.
    if (
      event.shiftKey &&
      !mod &&
      !event.altKey &&
      (event.key === "ArrowUp" || event.key === "ArrowDown")
    ) {
      event.preventDefault()
      extendSelection(event.key === "ArrowUp" ? "up" : "down")
      return
    }
    // Cmd/Ctrl+A grows the selection one structural rung (subtree → parent's
    // subtree → … → page); +Shift steps back down the same ladder.
    if (mod && !event.altKey && event.key.toLowerCase() === "a") {
      event.preventDefault()
      if (event.shiftKey) shrinkSelection()
      else escalateSelection()
      return
    }
    // Copy / cut the current selection — one block or many.
    if (mod && !event.altKey && event.key.toLowerCase() === "c") {
      event.preventDefault()
      copySelection()
      return
    }
    if (mod && !event.altKey && event.key.toLowerCase() === "x") {
      event.preventDefault()
      cutSelection()
      return
    }
    // Cmd/Ctrl+Shift+V pastes as plain text: flag it and let the browser's
    // native paste event fire (the container's onPaste reads the flag). Plain
    // Cmd/Ctrl+V needs nothing here — its paste event fires on its own.
    if (mod && event.shiftKey && event.key.toLowerCase() === "v") {
      plainPasteRef.current = true
      return
    }
    // Actions that only make sense on a multi-row selection.
    if (selectedKeys.length > 1) {
      const isArrow = event.key === "ArrowUp" || event.key === "ArrowDown"
      const direction = event.key === "ArrowUp" ? "up" : "down"
      // Shift+Alt+Arrow duplicates the selection roots as one group and
      // selects the copies.
      if (isArrow && event.altKey && event.shiftKey && !mod) {
        event.preventDefault()
        duplicateSelection(direction === "up" ? "above" : "below")
        return
      }
      // Alt+Arrow / Mod+Shift+Arrow move the whole contiguous selection one
      // position among its shared parent's children (no-op across parents).
      if (
        isArrow &&
        ((event.altKey && !event.shiftKey && !mod) || (mod && event.shiftKey && !event.altKey))
      ) {
        event.preventDefault()
        moveSelection(direction)
        return
      }
      if (event.key === "Tab") {
        event.preventDefault()
        if (event.shiftKey) outdentSelection()
        else indentSelection()
        return
      }
      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault()
        removeSelection()
        return
      }
      if (event.key === "Escape") {
        event.preventDefault()
        select(key)
        return
      }
      // Marker keys "turn into" across the whole selection: toggle each root
      // to the kind. Shift AND Alt are fine — # and > need Shift on many
      // layouts, and non-US Macs type symbols with Option (UK # is Alt+3).
      // Only Mod combos stay the browser's.
      const target = TURN_INTO_KEYS[event.key]
      if (target && !mod) {
        event.preventDefault()
        turnSelectionInto(target, true)
        return
      }
    }
    // Single-select: resolve through the keymap.
    if (dispatchKey("select", key, event)) event.preventDefault()
  }

  // Keep the container focused whenever a block is highlighted (select mode), so
  // arrow keys always move the highlight instead of scrolling the page — even
  // after a structural change or after focus drifted to a non-interactive spot.
  // Edit mode is left alone (the textarea owns focus). `preventScroll` stops the
  // focus call from jumping the page around on every doc change.
  //
  // Only focus that is NOWHERE (the body, or nothing) is taken: this runs on
  // every doc change, and a second editor on the page — the note's Unassigned
  // basket, walked from the same graph, so its doc changes on every keystroke
  // in the outline — used to take the keyboard from the textarea being typed
  // in, which left edit mode after a single character. A control that holds
  // focus (a textarea in another editor, the note's title, a dialog's input,
  // the query box typing over a results view whose rows change with every
  // letter) keeps it; the arrow-key replay below still brings the keys back
  // here.
  useLayoutEffect(() => {
    if (!navigable || focus || !selected) return
    const el = containerRef.current
    if (!el) return
    const active = document.activeElement
    if (active && active !== document.body) return
    el.focus({ preventScroll: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, focus, anchorKey, doc, navigable])

  // Keep the highlighted block centred as it moves, since focusing the
  // container itself no longer scrolls it into view. Let the browser do the
  // work with a native `scrollIntoView({ block: "center" })` — no manual
  // measuring to misfire and jump, and it correctly walks nested scroll
  // containers. We centre the inner content *line* (`data-block-line`), not the
  // row wrapper: the wrapper carries a heading's top margin, which would
  // otherwise distort where the highlight lands and make headings jump. When
  // the note fits on screen there's nothing to scroll, so this is a no-op.
  useLayoutEffect(() => {
    if (!navigable || focus || !selected) return
    const row = containerRef.current?.querySelector<HTMLElement>(`[data-occurrence="${selected}"]`)
    const line = row?.querySelector<HTMLElement>("[data-block-line]") ?? row
    if (!line || typeof line.scrollIntoView !== "function") return
    skipCenterScroll.current = false
    // Reveal, don't position (the VS Code model): a target already on screen
    // with a comfortable margin never scrolls — so clicks (the block is under
    // the pointer) and ladder moves hold still. A near target (arrowing past
    // the edge) scrolls minimally — `nearest` plus the scroll-margin band on
    // [data-block-line] gives keyboard travel a few lines of context, like
    // scrolloff. Only a far jump (palette, focus, search — more than a viewport
    // away) recentres for orientation.
    //
    // "On screen" is the window — narrowed to the nearest scrolling ancestor
    // when the editor sits in one (the palette's list), or a highlight could
    // sit below that box's edge, hidden, while still inside the viewport.
    const rect = line.getBoundingClientRect()
    let top = 0
    let bottom = window.innerHeight || document.documentElement.clientHeight
    const scroller = scrollParentOf(line)
    if (scroller) {
      const box = scroller.getBoundingClientRect()
      top = Math.max(top, box.top)
      bottom = Math.min(bottom, box.bottom)
    }
    const height = bottom - top
    const margin = Math.min(72, Math.floor(height / 4))
    if (rect.top >= top + margin && rect.bottom <= bottom - margin) return
    const far = rect.bottom < top - height || rect.top > bottom + height
    line.scrollIntoView({ block: far ? "center" : "nearest" })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, anchorKey, focus, navigable])

  // When focus falls to nothing (a click on empty page space) while a block is
  // still highlighted, keep the keyboard alive by re-grabbing focus. A click on
  // a real control elsewhere (relatedTarget set) is left to take focus.
  const handleContainerBlur = (event: FocusEvent<HTMLDivElement>) => {
    // Focus is leaving the container (for real controls, or possibly for
    // nothing): settle keyboard ownership on the next frame. If the re-grab
    // below (or anything else) puts focus back first, the check is a no-op.
    scheduleKeyboardIdleCheck()
    if (!navigable || focus || !selected || event.relatedTarget) return
    const el = containerRef.current
    requestAnimationFrame(() => {
      if (el && el.isConnected && !el.contains(document.activeElement)) {
        el.focus({ preventScroll: true })
      }
    })
  }

  // Select-mode paste: parse the clipboard into blocks and insert them after
  // the last block of the current selection — no need to enter edit mode first.
  // (Edit-mode paste is handled by the focused textarea and guarded out here.)
  const handleContainerPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const plain = plainPasteRef.current
    plainPasteRef.current = false
    if (readOnly || focus || !selected) return
    // The row pasted onto (the last of a range), and its block.
    const target = selectedKeys[selectedKeys.length - 1] ?? selected
    // A pasted picture becomes an image block after the row (images on).
    const files = imageFilesOf(event.clipboardData)
    if (files.length > 0) {
      if (!onImageUpload) return
      event.preventDefault()
      void insertImages(target, files)
      return
    }
    event.preventDefault()
    const text = event.clipboardData?.getData("text/plain") ?? ""
    const normalized = text.replace(/\r\n?/g, "\n")
    const targetId = idOfKey(target)
    // Pasting onto a selected block puts the content INSIDE it — in the graph
    // that is a link from the target down to what you pasted, which is what
    // "paste here" means when a block is the thing selected (a sibling would
    // be "paste next to"). The focused title reaches the same place: its body.

    /** Land a pasted fragment under `target`: reveal the target so the paste
     * is visible, and fold each pasted root so a big subtree arrives as one
     * line rather than dumping its whole tree into the view. */
    const settleAfterPaste = (rootIds: string[], nextDoc: BlockDoc) => {
      setCollapsedState(target, false)
      for (const id of rootIds) {
        // Pasted roots land as the target's first children.
        if ((nextDoc.blocks[id]?.children.length ?? 0) > 0)
          setCollapsedState(keyOf(target, id), true)
      }
    }
    if (plain) {
      // Paste-as-plain: one new paragraph block, newlines collapsed to spaces
      // (a block is a single line in the serialized format). Bypasses the html
      // flavor entirely.
      if (normalized.trim() === "") return
      const fresh = emptyBlock("text", normalized.replace(/\s*\n+\s*/g, " ").trim())
      const next = insertFirstChild(doc, targetId, fresh)
      if (next === doc) return
      setCollapsedState(target, false)
      history.commit(doc, next, { type: "structural" })
      setAnchorKey(null)
      setFocus(null)
      setSelected(keyOf(target, fresh.id))
      return
    }
    // Rich paste: prefer the html flavor — our own embedded block payload
    // first (exact rebuild, no markdown parsing), then converted foreign html
    // — and fall back to text/plain parsed as markdown, exactly as before.
    const html = event.clipboardData?.getData("text/html") ?? ""
    let pasted: BlockDoc | null = null
    if (html.trim() !== "") {
      const embedded = extractClipboardBlocks(html)
      if (embedded && embedded.length > 0) {
        // A block can't be put inside itself: that root is dropped, and when
        // it was the whole paste a toast says so.
        const others = embedded.filter((block) => block.id !== targetId)
        if (others.length === 0) {
          toast("A block can't be put inside itself")
          return
        }
        // A Ruminate payload: link, duplicate, or skip per block — the
        // fragment arrives with its ids already settled, so it bypasses the
        // remint below (reminting would undo the link).
        const fragment = embeddedPasteFragment(others, doc, target, resolveBlocks)
        if (!fragment) {
          // Every pasted block already hangs directly under the target: nothing
          // to do, but say so — a paste that does nothing looks broken.
          toast(others.length > 1 ? "Those blocks are already here" : "That block is already here")
          return
        }
        const linked = insertBlocksAsFirstChildren(doc, targetId, fragment)
        if (!linked) return
        settleAfterPaste(fragment.rootBlockIds, linked.doc)
        history.commit(doc, linked.doc, { type: "structural" })
        setAnchorKey(null)
        setFocus(null)
        setSelected(keyOf(target, linked.lastId))
        return
      }
      const converted = htmlToMarkdown(html)
      if (converted.trim() !== "") pasted = parse(converted)
    }
    if (!pasted) {
      if (normalized.trim() === "") return
      pasted = parse(normalized)
    }
    // Remint any pasted ids that already exist here (e.g. content copied with
    // its `id::` lines) so the paste never clobbers an existing block.
    const sub = remintCollidingIds(pasted, doc)
    const result = insertBlocksAsFirstChildren(doc, targetId, sub)
    if (!result) return
    settleAfterPaste(sub.rootBlockIds, result.doc)
    history.commit(doc, result.doc, { type: "structural" })
    setAnchorKey(null)
    setFocus(null)
    setSelected(keyOf(target, result.lastId))
  }

  // The rows a DOM text selection touches, in view order, each as one block
  // line (content + id line, so a count of entries is a count of rows; the id
  // rides to the embedded payload only). `partial` when the selection covers
  // some row only in part. Rows are what is on screen — a folded subtree's
  // hidden rows are never picked, so a cut never deletes what the user could
  // not see selected.
  const pickSelectedRows = (selection: Selection) => {
    const picked: string[] = []
    const keys: string[] = []
    let partial = false
    for (const row of rows) {
      const block = doc.blocks[row.id]
      const el = containerRef.current?.querySelector(
        `[data-occurrence="${row.key}"] [data-block-id]`,
      )
      if (!block || !el || !selection.containsNode(el, true)) continue
      if (!selection.containsNode(el, false)) partial = true
      const indent = "  ".repeat(row.depth)
      picked.push(
        [...blockLines(block).map((line) => indent + line), `${indent}  id:: ${block.id}`].join(
          "\n",
        ),
      )
      keys.push(row.key)
    }
    return { picked, keys, partial }
  }

  // Native cut over a DOM text selection: only when the selection fully covers
  // every row it touches do we take over — copy them as markdown and remove
  // them in one structural step. Partial coverage is a strict no-op, so content
  // the user didn't fully select is never deleted.
  const handleCut = (event: ClipboardEvent<HTMLDivElement>) => {
    if (readOnly || focus) return
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) return

    const { picked, keys, partial } = pickSelectedRows(selection)
    if (picked.length === 0 || partial) return
    const pickedSet = new Set(keys)
    // Never let a native cut delete the focused title out of its own view.
    if (focusRootKey !== null && pickedSet.has(focusRootKey)) return

    // Removal happens by subtree root; every row a root drags along must
    // itself be covered, or the cut would delete unselected content.
    const roots = keys.filter((key) => !ancestorKeys(key).some((a) => pickedSet.has(a)))
    const covered = (key: string): boolean => {
      if (!pickedSet.has(key)) return false
      return (doc.blocks[idOfKey(key)]?.children ?? []).every((child) => covered(keyOf(key, child)))
    }
    if (!roots.every(covered)) return

    const formats = richClipboardFormats(picked.join("\n"))
    event.clipboardData.setData("text/plain", formats.plain)
    event.clipboardData.setData("text/html", formats.html)
    event.preventDefault()

    let next = doc
    let focusKey: string | null = null
    for (const key of roots) {
      if (!hasOccurrence(next, key)) continue
      const result = removeBlock(next, key)
      next = result.doc
      focusKey = result.focusKey
    }
    if (next === doc) return
    if (focusKey && !hasOccurrence(next, focusKey)) focusKey = null
    history.commit(doc, next, { type: "structural" })
    setAnchorKey(null)
    setFocus(null)
    setSelected(focusKey ?? firstSelectable(next))
  }

  const handleCopy = (event: ClipboardEvent<HTMLDivElement>) => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) return

    const { picked } = pickSelectedRows(selection)

    // Only take over for multi-row selections; a partial single-row copy is
    // better served by the plain selected text.
    if (picked.length < 2) return
    // Route through the same display-markdown path as every other copy action so
    // the result is clean markdown (blank lines between prose, GFM todos) rather
    // than raw block lines with bare `[ ]` markers run together — plus the html
    // flavor carrying the exact block tree for a Ruminate→Ruminate round-trip.
    const formats = richClipboardFormats(picked.join("\n"))
    event.clipboardData.setData("text/plain", formats.plain)
    event.clipboardData.setData("text/html", formats.html)
    event.preventDefault()
  }

  // Breadcrumb while focused: the hops before the current root — the path
  // the user actually took, in order (levels are never dropped — long labels
  // truncate with CSS instead). Read up to the root rather than off the end,
  // so the frame between a focus change and the stack's reconciliation shows
  // the trail it will settle on. Clicking a crumb truncates the stack back to
  // it via the reconciliation effect.
  const crumbs = useMemo(() => {
    if (!focusRootId) return []
    const at = focusStack.findIndex((hop) => hop.id === focusRootId)
    return at === -1 ? focusStack : focusStack.slice(0, at)
  }, [focusRootId, focusStack])
  const crumbLabel = (text: string): string => {
    const trimmed = text.trim()
    return trimmed === "" ? "…" : trimmed
  }
  // `focus-ring`: a crumb is a real button and had no focus style at all, so
  // a keyboard user walking the focus trail could not see where they were.
  const crumbClass =
    "focus-ring min-w-0 max-w-48 cursor-pointer truncate rounded-sm px-1 transition-colors duration-150 hover:bg-bg-hover hover:text-text"

  // ── Guide lines ───────────────────────────────────────────────────────────
  // Every row draws the guide lines of the rows it is indented under (one per
  // level, `guideKeys`), so a parent's line runs continuously beside its
  // subtree. Pointing anywhere in a subtree brightens the lines that trace it
  // — the guides of the row under the pointer and of all its ancestors. That
  // is a class toggled straight on the DOM: the rows themselves never
  // re-render for a hover.
  const hotGuides = useRef<{ key: string | null; els: Element[] }>({ key: null, els: [] })
  const setHotGuides = (key: string | null) => {
    if (hotGuides.current.key === key) return
    for (const el of hotGuides.current.els) el.classList.remove("block-guide-hot")
    hotGuides.current = { key, els: [] }
    const container = containerRef.current
    if (key === null || !container) return
    const segments = key.split("/")
    const selector = segments
      .map((_, i) => `[data-guide="${segments.slice(0, i + 1).join("/")}"]`)
      .join(",")
    const els = Array.from(container.querySelectorAll(selector))
    for (const el of els) el.classList.add("block-guide-hot")
    hotGuides.current.els = els
  }
  const handleMouseOver = (event: MouseEvent<HTMLDivElement>) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-occurrence]")
    setHotGuides(row?.dataset.occurrence ?? null)
  }

  return (
    <>
      {focusRoot ? (
        <nav
          aria-label="Focus path"
          data-testid="focus-breadcrumb"
          // `note-header` hangs the trail into the page gutter with the
          // title (block-editor.css): the first crumb's text keeps starting
          // where the marker slot does, now the focus title's hanging #.
          className="note-header mb-3 flex min-w-0 items-center gap-0.5 font-content text-sm text-text-secondary"
        >
          <button type="button" className={crumbClass} onClick={() => navigateFocus(null)}>
            {noteTitle?.trim() || "Note"}
          </button>
          {crumbs.map((hop) => (
            <Fragment key={hop.id}>
              <span aria-hidden className="text-text-tertiary">
                ›
              </span>
              <button type="button" className={crumbClass} onClick={() => navigateFocus(hop.id)}>
                {crumbLabel(hop.text)}
              </button>
            </Fragment>
          ))}
          <span aria-hidden className="text-text-tertiary">
            ›
          </span>
          <span aria-current="page" className="min-w-0 max-w-48 truncate px-1 text-text">
            {crumbLabel(focusRoot.text)}
          </span>
        </nav>
      ) : null}
      {focusRoot && focusTitled ? (
        // A focused HEADING is the page: its text is the title, drawn by the
        // component the page draws the note's title with, and edited there
        // as a title is — a rename of the block. The rows beneath are its
        // children; ↑ from the first hands the keyboard up here, ↓ and Enter
        // hand it back down. Every other type has no title: it is the first
        // row instead (`titlesFocus`), and the rows read as they do outside focus.
        <div className="mb-3">
          <NoteTitle
            title={focusRoot.text}
            label="Block title"
            onRename={renameFocusRoot}
            readOnly={readOnly || !focusTitleEditable}
            focusSignal={focusTitleSignal}
            onArrowDown={focusFirstRow}
            onCreateBelow={newRootBlock}
          />
        </div>
      ) : null}
      {coarse ? (
        <>
          {/* The container holds keyboard focus for select mode (tabIndex -1 =
            focusable only programmatically), so arrows/shortcuts work no matter
            which block is highlighted. outline-none hides the focus ring. */}
          {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
          <div
            className={cx(
              "outline-none",
              // Under a finger a press-and-hold opens the block's menu, so
              // nothing in the rows may start a selection: not a card's
              // title, a caption, a badge or the gap beside a row. The
              // textarea being edited takes selection back (`select-text`,
              // said outright: iOS ignores a field under `select-none`).
              // No callout either — iOS's own menu on a held link or image.
              !readOnly && "coarse:select-none coarse:[-webkit-touch-callout:none]",
            )}
            ref={containerRef}
            tabIndex={-1}
            data-block-editor=""
            onKeyDown={handleKeyDown}
            onFocus={handleContainerFocus}
            onBlur={handleContainerBlur}
            onCopy={handleCopy}
            onPaste={handleContainerPaste}
            onCut={handleCut}
            onMouseOver={handleMouseOver}
            onMouseLeave={() => setHotGuides(null)}
            onContextMenuCapture={handleContextMenuCapture}
            onTouchEndCapture={handleTouchEndCapture}
            onTouchCancelCapture={handleTouchEndCapture}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={cancelPress}
            onPointerCancel={cancelPress}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            {/* The view is a flat list: one row per occurrence, indented by its
            depth. In focus under a title, the rows are the focused block's
            children, from depth 0, under its title above; without one, the
            focused block leads them as the first row. */}
            {renderRows(
              rows.filter((row) => {
                const parent = parentKeyOf(row.key)
                return parent === null || !rowKeys.has(parent)
              }),
            )}
          </div>
          <BlockMenuSheet
            target={readOnly ? null : menuTarget}
            title={menuTarget ? (doc.blocks[menuTarget.id]?.text ?? "") : ""}
            actions={menuActions}
            holding={holding}
            open={sheetOpen && menuTarget !== null}
            onOpenChange={(open) => {
              if (!open) closeSheet()
            }}
          />
        </>
      ) : (
        <BlockContextMenu
          target={readOnly ? null : menuTarget}
          actions={menuActions}
          onOpenChange={handleMenuOpenChange}
        >
          {/* The container holds keyboard focus for select mode (tabIndex -1 =
            focusable only programmatically), so arrows/shortcuts work no matter
            which block is highlighted. outline-none hides the focus ring. */}
          {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
          <div
            className={cx(
              "outline-none",
              // Under a finger a press-and-hold opens the block's menu, so
              // nothing in the rows may start a selection: not a card's
              // title, a caption, a badge or the gap beside a row. The
              // textarea being edited takes selection back (`select-text`,
              // said outright: iOS ignores a field under `select-none`).
              // No callout either — iOS's own menu on a held link or image.
              !readOnly && "coarse:select-none coarse:[-webkit-touch-callout:none]",
            )}
            ref={containerRef}
            tabIndex={-1}
            data-block-editor=""
            onKeyDown={handleKeyDown}
            onFocus={handleContainerFocus}
            onBlur={handleContainerBlur}
            onCopy={handleCopy}
            onPaste={handleContainerPaste}
            onCut={handleCut}
            onMouseOver={handleMouseOver}
            onMouseLeave={() => setHotGuides(null)}
            onContextMenuCapture={handleContextMenuCapture}
            onTouchEndCapture={handleTouchEndCapture}
            onTouchCancelCapture={handleTouchEndCapture}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={cancelPress}
            onPointerCancel={cancelPress}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            {/* The view is a flat list: one row per occurrence, indented by its
            depth. In focus under a title, the rows are the focused block's
            children, from depth 0, under its title above; without one, the
            focused block leads them as the first row. */}
            {renderRows(
              rows.filter((row) => {
                const parent = parentKeyOf(row.key)
                return parent === null || !rowKeys.has(parent)
              }),
            )}
          </div>
        </BlockContextMenu>
      )}
      {onImageUpload ? (
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          data-testid="image-input"
          onChange={handleImagePicked}
        />
      ) : null}
      <ImageLightbox
        block={lightbox ? (doc.blocks[lightbox] ?? null) : null}
        onClose={() => setLightbox(null)}
      />
      {!coarse && !readOnly && navigable ? (
        <SelectionBar
          open={selectedKeys.length > 1 && keyboardActive}
          count={selectedKeys.length}
          state={selectionMoves()}
          finalFocus={containerRef}
          actions={{
            indent: indentSelection,
            outdent: outdentSelection,
            moveUp: () => moveSelection("up"),
            moveDown: () => moveSelection("down"),
            duplicate: () => duplicateSelection("below"),
            turnInto: (type) => turnSelectionInto(type),
            copy: copySelection,
            cut: cutSelection,
            remove: removeSelection,
            // Back to the head row alone, as Escape does.
            clear: () => {
              if (selected) select(selected)
            },
          }}
        />
      ) : null}
      {coarse && !readOnly && focus ? (
        <MobileEditBar
          state={{
            type: doc.blocks[idOfKey(focus.key)]?.type ?? "text",
            ...structureMoves(focus.key),
            // The focused block leads its own view: focusing on it again
            // would go nowhere.
            canFocus: idOfKey(focus.key) !== focusRootId,
            canUndo: history.canUndo(),
            canRedo: history.canRedo(),
          }}
          actions={{
            turnInto: (type) => setBlockType(idOfKey(focus.key), type),
            bold: () => runOnEditing("wrapBold"),
            italic: () => runOnEditing("wrapItalic"),
            strike: () => runOnEditing("wrapStrike"),
            code: () => runOnEditing("wrapCode"),
            link: () => runOnEditing("wrapLink"),
            math: () => runOnEditing("wrapMath"),
            indent: () => runOnEditing("indent"),
            outdent: () => runOnEditing("outdent"),
            // What ⌘. does while typing: the block becomes the whole view.
            // The change of focus root ends the edit (the focus-change
            // effect), so the keyboard goes and the view is there to read.
            focus: () => runOnEditing("focusBlock"),
            undo,
            redo,
            // In edit mode, so the edit carries on in the row that takes
            // the deleted one's place and the keyboard stays up.
            remove: () => runOnEditing("deleteBlock"),
            image: api.requestImage ? () => api.requestImage?.(focus.key) : undefined,
            // Done: the keyboard goes and the row stays highlighted, where
            // a tap starts the next edit. The blur ends the edit itself;
            // setting focus here too covers a keyboard that was already
            // down (Android's Back key hides it without a blur).
            done: () => {
              const key = focus.key
              setFocus(null)
              setSelected(key)
              setAnchorKey(null)
              if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
            },
          }}
        />
      ) : null}
    </>
  )
}
