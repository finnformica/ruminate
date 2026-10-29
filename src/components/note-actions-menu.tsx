import { useLocation, useNavigate } from "@tanstack/react-router"
import copy from "copy-to-clipboard"
import { useAtom, useAtomValue, useSetAtom, useStore } from "jotai"
import React from "react"
import { blockIndexAtom, graphSnapshotAtom, isSignedOutAtom, notesAtom } from "../global-state"
import { filteredRollup } from "../data/filter-view"
import { CORPUS_ROOT_ID, blockRollup, rollup } from "../data/graph"
import { receivedSharesAtom, sharePermissions, sharedOriginAtom } from "../data/shared-mode"
import { copyAsMarkdown } from "../utils/copy-markdown"
import { viewNarrowing } from "../utils/view-narrowing"
import { developerDebugPreferenceAtom, useIsDeveloper } from "../hooks/is-developer"
import { useNoteShare } from "../hooks/share"
import { useMakeBoard, useMakeNote } from "../hooks/board"
import { useMakeTracker } from "../hooks/tracker"
import { useRenameNote } from "../hooks/note"
import { useSetPinned } from "../hooks/pins"
import { pinnedAtOf } from "../data/pins"
import { deleteNoteDialogAtom } from "./delete-note-dialog"
import { shareDialogAtom } from "./share-note-dialog"
import type { Width } from "../schema"
import { cx } from "../utils/cx"
import { MenuItems, type MenuEntry } from "./block-editor/block-context-menu"
import { DropdownMenu } from "./ui/dropdown-menu"
import { IconButton } from "./ui/icon-button"
import {
  ArrowDownIcon16,
  ArrowUpIcon16,
  BoardIcon16,
  TrackerIcon16,
  CopyIcon16,
  EditIcon16,
  ListIcon16,
  MoreIcon16,
  NoteIcon16,
  PinIcon16,
  PrinterIcon16,
  ShareIcon16,
  TrashIcon16,
  WidthFixedIcon16,
  WidthFullIcon16,
} from "./icons"

/** What the open note's header adds to the menu. */
interface EditorActions {
  showWidth?: boolean
  width?: Width
  onWidth?: (width: Width) => void
  /**
   * In a split, sets the app's width setting (Settings → Editor) and clears
   * every pane's own override, so every pane follows it again. Absent with
   * one pane, where the Width item already sets the app setting itself.
   */
  onUseForAllPanes?: (width: Width) => void
  /** Called after the open note is deleted, so the page can navigate away. */
  onDeleted?: () => void
  /**
   * The block the page is focused on, if any. What the menu copies follows
   * the view: focused in, **Copy markdown** takes that block and everything
   * beneath it — what is on screen — rather than the whole note behind it.
   */
  focusBlockId?: string | null
  /**
   * The view's filter, if any (the query-language string the page narrows
   * by). Filtered, **Copy markdown** takes only the rows the view shows.
   */
  filter?: string
  /**
   * The pivot on the view's root (docs/graph-walk.md, Q6): whether the view
   * shows what holds the root (upstream) in place of its blocks, and the
   * way to switch. Absent where the view keeps no frame.
   */
  rootPivot?: { upstream: boolean; onToggle: () => void }
}

/**
 * **The note's menu, as entries** (`MenuEntry`, one list for every surface):
 * Copy markdown, Copy ID, Share, Rename, the board entries, then Print,
 * then Delete. The sidebar's ⋯ on a note row draws it (`NoteActionsMenu`), the open note's
 * header draws it with its own extras around it, a right-click on a Pinned
 * row in the sidebar draws it, and so does a right-click on a note's row in
 * the palette (`results-editor.tsx`) — so a note has one menu wherever it is
 * met.
 *
 * A hook that returns a builder rather than the entries: the surfaces that
 * list many notes (the palette's results) build a list per row at the moment the
 * menu opens, so what varies per note is read from the store then, not
 * subscribed to per row. Nothing here touches the router, so a surface
 * outside one (a story) can draw the menu too; where deleting should lead
 * somewhere, the caller says so (`onDeleted`).
 *
 * A note someone shared with the user (docs/sharing.md): its rows are the
 * owner's, so the verbs the owner granted decide what the menu offers.
 * Sharing is the owner's alone: an own note, signed in.
 *
 * A note's default surface is one property on its page (docs/boards.md):
 * **Make this a board** sets it — writing the default features onto the
 * page as **New board** does (`useMakeBoard`) — and opens the board,
 * **Make this a note** clears it, and a board's outline offers **Open
 * board** to get back. Own notes only (signed out, the sample graph in
 * memory, as **New board** does), and only where the caller can open the
 * board (`openBoard`);
 * so neither is offered one. The board page itself adds **Features**,
 * which opens its Features editor (`openFeatures`).
 *
 * **Pin** and **Unpin** are the note's place in the sidebar's Pinned list
 * (`src/data/pins.ts`): its root's `pinned_at` prop. Own notes only — a
 * shared note is listed under Shared, by the share, and its props are the
 * owner's.
 */
export function useNoteMenuEntries() {
  const isSignedOut = useAtomValue(isSignedOutAtom)
  const jotaiStore = useStore()
  const renameNote = useRenameNote()
  // Delete asks first (`delete-note-dialog.tsx`); the menu only opens it.
  const requestDelete = useSetAtom(deleteNoteDialogAtom)
  const openShare = useSetAtom(shareDialogAtom)
  const makeBoard = useMakeBoard()
  const makeTracker = useMakeTracker()
  const makeNote = useMakeNote()
  const setPinned = useSetPinned()
  // Subscribed, not read as the menu opens: a sidebar row draws its menu
  // when it renders, so the entries follow the note's pin as it changes.
  const graph = useAtomValue(graphSnapshotAtom)
  return React.useCallback(
    (
      noteId: string,
      options: {
        focusBlockId?: string | null
        /** The view's filter: copy only the rows it shows. */
        filter?: string
        onDeleted?: () => void
        /** Opens the note's board page, where the surface can do so. */
        openBoard?: () => void
        /** Opens the note's outline: what the board page passes instead,
         * being the board already. */
        openOutline?: () => void
        /** Opens the board's Features editor: the board page's own. */
        openFeatures?: () => void
        /** Opens the note's tracker page (docs/trackers.md), where the
         * surface can do so. */
        openTracker?: () => void
        /** Opens the tracker's Series editor: the tracker page's own. */
        openSeries?: () => void
      } = {},
    ) => {
      const shareId = jotaiStore.get(sharedOriginAtom).get(noteId)
      const share =
        shareId === undefined
          ? undefined
          : jotaiStore.get(receivedSharesAtom).find((entry) => entry.id === shareId)
      const verbs = share ? sharePermissions(share) : null
      const canRename = !isSignedOut && (verbs === null || verbs.write)
      const canDelete = !isSignedOut && (verbs === null || verbs.delete)
      const canShare = !isSignedOut && verbs === null

      // Copy what the view holds, not what the note holds: focused on a
      // block, that block and everything beneath it. A focused block the
      // graph has since lost falls back to the note, which is what the page
      // itself falls back to. Filtered, only the rows the view shows, a
      // match's ancestors (its context) with it; the sort is the view's
      // order, not its content, so the copy keeps the note's own.
      const copyMarkdown = () => {
        const graph = jotaiStore.get(graphSnapshotAtom)
        const { matched } = viewNarrowing({
          filter: options.filter,
          noteId,
          index: jotaiStore.get(blockIndexAtom),
        })
        if (matched !== null) {
          copyAsMarkdown(filteredRollup(noteId, options.focusBlockId ?? null, matched, graph) ?? "")
          return
        }
        const focused = options.focusBlockId ? blockRollup(options.focusBlockId, graph) : null
        copyAsMarkdown(focused ?? rollup(noteId, graph) ?? "")
      }

      // Renaming sets the note's title (docs/graph-storage.md). The id and
      // the URL are untouched, so there is nothing to navigate to afterwards
      // and no name to reject: any text is a valid title.
      const rename = () => {
        const current = jotaiStore.get(notesAtom).get(noteId)?.title ?? ""
        const raw = window.prompt("Rename note", current)
        if (raw == null) return
        renameNote({ noteId, newTitle: raw })
      }

      const remove = () => requestDelete({ noteId, onDeleted: options.onDeleted })

      // The board entries: which of them a note gets is its kind, read as
      // the menu opens, like the rest.
      const kind = jotaiStore.get(notesAtom).get(noteId)?.type
      const canBoard = verbs === null && !!(options.openBoard || options.openOutline)
      // On the board itself the way across is to the outline, and a board
      // made a note is opened there, since the board page refuses a note.
      // A tracker's entries are the same shape (docs/trackers.md).
      const boardEntries: MenuEntry[] = !canBoard
        ? []
        : kind === "tracker"
          ? [
              ...(options.openSeries
                ? [
                    {
                      kind: "item" as const,
                      label: "Series",
                      icon: <ListIcon16 />,
                      onSelect: () => options.openSeries?.(),
                    },
                  ]
                : []),
              options.openOutline
                ? {
                    kind: "item",
                    label: "Open note",
                    icon: <NoteIcon16 />,
                    onSelect: () => options.openOutline?.(),
                  }
                : {
                    kind: "item",
                    label: "Open tracker",
                    icon: <TrackerIcon16 />,
                    onSelect: () => options.openTracker?.(),
                  },
              {
                kind: "item",
                label: "Make this a note",
                icon: <NoteIcon16 />,
                onSelect: () => {
                  makeNote(noteId)
                  options.openOutline?.()
                },
              },
            ]
          : kind === "board"
            ? [
                ...(options.openFeatures
                  ? [
                      {
                        kind: "item" as const,
                        label: "Features",
                        icon: <ListIcon16 />,
                        onSelect: () => options.openFeatures?.(),
                      },
                    ]
                  : []),
                options.openOutline
                  ? {
                      kind: "item",
                      label: "Open note",
                      icon: <NoteIcon16 />,
                      onSelect: () => options.openOutline?.(),
                    }
                  : {
                      kind: "item",
                      label: "Open board",
                      icon: <BoardIcon16 />,
                      onSelect: () => options.openBoard?.(),
                    },
                {
                  kind: "item",
                  label: "Make this a note",
                  icon: <NoteIcon16 />,
                  onSelect: () => {
                    makeNote(noteId)
                    options.openOutline?.()
                  },
                },
              ]
            : kind === "note" && options.openBoard
              ? [
                  {
                    kind: "item",
                    label: "Make this a board",
                    icon: <BoardIcon16 />,
                    onSelect: () => {
                      makeBoard(noteId)
                      options.openBoard?.()
                    },
                  },
                  ...(options.openTracker
                    ? [
                        {
                          kind: "item" as const,
                          label: "Make this a tracker",
                          icon: <TrackerIcon16 />,
                          onSelect: () => {
                            makeTracker(noteId)
                            options.openTracker?.()
                          },
                        },
                      ]
                    : []),
                ]
              : []

      // The note's pin: its root's `pinned_at`.
      const root = graph.nodes.get(noteId)
      const pinned = root !== undefined && pinnedAtOf(root) !== null
      const pinEntries: MenuEntry[] =
        verbs !== null || root === undefined
          ? []
          : [
              { kind: "separator" },
              {
                kind: "item",
                label: pinned ? "Unpin" : "Pin",
                icon: <PinIcon16 />,
                onSelect: () => setPinned([noteId], !pinned),
              },
            ]

      return [
        { kind: "item", label: "Copy markdown", icon: <CopyIcon16 />, onSelect: copyMarkdown },
        { kind: "item", label: "Copy ID", icon: <CopyIcon16 />, onSelect: () => copy(noteId) },
        {
          kind: "item",
          label: "Share",
          icon: <ShareIcon16 />,
          disabled: !canShare,
          onSelect: () => openShare(noteId),
        },
        {
          kind: "item",
          label: "Rename",
          icon: <EditIcon16 />,
          disabled: !canRename,
          onSelect: rename,
        },
        ...boardEntries,
        ...pinEntries,
        { kind: "separator" },
        { kind: "item", label: "Print", icon: <PrinterIcon16 />, onSelect: () => window.print() },
        { kind: "separator" },
        {
          kind: "item",
          label: "Delete",
          icon: <TrashIcon16 />,
          danger: true,
          disabled: !canDelete,
          onSelect: remove,
        },
      ] satisfies MenuEntry[]
    },
    [
      jotaiStore,
      isSignedOut,
      renameNote,
      requestDelete,
      openShare,
      makeBoard,
      makeTracker,
      makeNote,
      setPinned,
      graph,
    ],
  )
}

/**
 * The one note-actions menu, used both by the open note's header and by each
 * sidebar row — so the actions and styling stay identical. Its entries are
 * `useNoteMenuEntries`'; the header's extras (width, the developer toggles)
 * sit around them.
 */
export function NoteActionsMenu({
  noteId,
  className,
  align = "start",
  editor,
  surface = "outline",
  onFeatures,
  onSeries,
  groups,
}: {
  noteId: string
  className?: string
  align?: "start" | "end"
  editor?: EditorActions
  /** Where the menu is drawn: the board page says so, and gets the way to
   * the outline where every other surface gets the way to the board. */
  surface?: "outline" | "board" | "tracker"
  /** Opens the board's Features editor: the board page passes it. */
  onFeatures?: () => void
  /** Opens the tracker's Series editor: the tracker page passes it. */
  onSeries?: () => void
  /**
   * The page's own groups (`DropdownMenu.Group`s), drawn first and set off
   * from the note's entries by a rule: the tracker page's Range and Layout.
   * The same menu at every width, so a phone and a desktop get one pattern.
   */
  groups?: React.ReactNode
}) {
  const entriesFor = useNoteMenuEntries()
  const navigate = useNavigate()
  const location = useLocation()
  // The header menu passes onDeleted (it's always the open note); the
  // sidebar menu falls back to the path check so deleting the note you're
  // viewing from the list also takes you home. Compare the decoded path
  // segment, not the raw pathname: a note id with a space or other special
  // character is percent-encoded in the URL, so a raw `=== /notes/${noteId}`
  // check would miss it and skip the redirect. A board's or a tracker's page counts too.
  const openMatch = location.pathname.match(/^\/(?:notes|boards|trackers)\/(.+)$/)
  const openNoteId = openMatch ? decodeURIComponent(openMatch[1]) : ""
  const onDeleted =
    editor?.onDeleted ??
    (openNoteId === noteId
      ? () => navigate({ to: "/", search: { query: undefined }, replace: true })
      : undefined)
  // Developer mode (`src/hooks/is-developer.ts`): the debug toggles live at
  // the bottom of the open note's menu, for the developer's account only.
  const isDeveloper = useIsDeveloper()
  const [debug, setDebug] = useAtom(developerDebugPreferenceAtom)
  // Width is a prop on the note node — the owner's — so a shared note has
  // none.
  const share = useNoteShare(noteId)

  return (
    <DropdownMenu modal={false}>
      <DropdownMenu.Trigger
        render={
          <IconButton
            aria-label="Note actions"
            size="small"
            disableTooltip
            className={cx("shrink-0", className)}
          >
            <MoreIcon16 />
          </IconButton>
        }
      />
      <DropdownMenu.Content align={align}>
        {groups ? (
          <>
            {groups}
            <DropdownMenu.Separator />
          </>
        ) : null}
        {editor?.showWidth && editor.onWidth && share === null ? (
          <>
            <DropdownMenu.Group>
              <DropdownMenu.GroupLabel>Width</DropdownMenu.GroupLabel>
              <DropdownMenu.Item
                icon={<WidthFixedIcon16 />}
                selected={editor.width === "fixed"}
                onClick={() => editor.onWidth?.("fixed")}
              >
                Fixed
              </DropdownMenu.Item>
              <DropdownMenu.Item
                icon={<WidthFullIcon16 />}
                selected={editor.width === "full"}
                onClick={() => editor.onWidth?.("full")}
              >
                Full
              </DropdownMenu.Item>
              {editor.onUseForAllPanes ? (
                <DropdownMenu.Item
                  onClick={() => editor.onUseForAllPanes?.(editor.width ?? "fixed")}
                >
                  Use for all panes
                </DropdownMenu.Item>
              ) : null}
            </DropdownMenu.Group>
            <DropdownMenu.Separator />
          </>
        ) : null}
        {editor?.rootPivot ? (
          <>
            <DropdownMenu.Item
              icon={editor.rootPivot.upstream ? <ArrowDownIcon16 /> : <ArrowUpIcon16 />}
              onClick={editor.rootPivot.onToggle}
            >
              {editor.rootPivot.upstream ? "Show downstream" : "Show upstream"}
            </DropdownMenu.Item>
            <DropdownMenu.Separator />
          </>
        ) : null}
        <MenuItems
          entries={[
            // The Root frame's menu has the page's items only: the corpus root
            // is no note to rename, share, list or delete.
            ...(noteId === CORPUS_ROOT_ID
              ? []
              : entriesFor(noteId, {
                  focusBlockId: editor?.focusBlockId,
                  filter: editor?.filter,
                  onDeleted,
                  ...(surface === "board"
                    ? {
                        openOutline: () =>
                          navigate({
                            to: "/notes/$",
                            params: { _splat: noteId },
                            search: { query: undefined },
                          }),
                        openFeatures: onFeatures,
                      }
                    : surface === "tracker"
                      ? {
                          openOutline: () =>
                            navigate({
                              to: "/notes/$",
                              params: { _splat: noteId },
                              search: { query: undefined },
                            }),
                          openSeries: onSeries,
                        }
                      : {
                          openBoard: () =>
                            navigate({ to: "/boards/$", params: { _splat: noteId } }),
                          openTracker: () =>
                            navigate({ to: "/trackers/$", params: { _splat: noteId } }),
                        }),
                })),
          ]}
        />
        {editor && isDeveloper ? (
          <>
            <DropdownMenu.Separator />
            <DropdownMenu.Group>
              <DropdownMenu.GroupLabel>Developer</DropdownMenu.GroupLabel>
              <DropdownMenu.Item
                selected={debug.blockIds === true}
                closeOnClick={false}
                onClick={() => setDebug({ ...debug, blockIds: !debug.blockIds })}
              >
                Show block ids
              </DropdownMenu.Item>
              <DropdownMenu.Item
                selected={debug.blockMetadata === true}
                closeOnClick={false}
                onClick={() => setDebug({ ...debug, blockMetadata: !debug.blockMetadata })}
              >
                Show block metadata
              </DropdownMenu.Item>
            </DropdownMenu.Group>
          </>
        ) : null}
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
