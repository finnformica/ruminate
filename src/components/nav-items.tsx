import { Link, LinkComponentProps, useLocation, useNavigate } from "@tanstack/react-router"
import { useAtom, useAtomValue } from "jotai"
import React, { createContext, useContext } from "react"
import { requestDatabasePull } from "../data/database-mode"
import { CORPUS_ROOT_ID } from "../data/graph"
import { layoutToSearch, type FocusFrame, type PaneSearch } from "../data/panes"
import { ROOT_LABEL, rootFrame } from "../data/root-frame"
import { restoreViewFrames } from "../data/view-stack"
import { viewByRootAtom } from "../data/views"
import {
  graphSnapshotAtom,
  isBootingAtom,
  isHelpPanelOpenAtom,
  noteSortAtom,
  sharedNotesAtom,
  viewEntriesAtom,
  type BlockView,
  type NoteSort,
  type ViewEntry,
} from "../global-state"
import { appUpdateAtom } from "../hooks/app-update"
import { usePending } from "../hooks/pending"
import { useReorderViews } from "../hooks/views"
import { useDragReorder } from "../hooks/drag-reorder"
import { useOpenFramesInPane, useOpenInPane } from "../hooks/open-note"
import { shareOwnerName } from "../data/shares"
import type { Note } from "../schema"
import { typeGlyph } from "../blocks/registry"
import { BlockKey, hasBlockKey } from "./block-editor/block-key"
import { kindOf } from "./block-editor/block-kinds"
import type { BlockType } from "../blocks/types"
import { APP_SHORTCUTS, formatCombo } from "../shortcuts/registry"
import { cx } from "../utils/cx"
import { inlineText } from "../utils/inline-text"
import { toDateString } from "../utils/date"
import { DropdownMenu } from "./ui/dropdown-menu"
import { IconButton } from "./ui/icon-button"
import {
  CalendarDateFillIcon16,
  CalendarDateIcon16,
  CircleQuestionMarkFillIcon16,
  CircleQuestionMarkIcon16,
  GridFillIcon16,
  GridIcon16,
  HistoryFillIcon16,
  HistoryIcon16,
  ListIcon16,
  LoadingIcon16,
  MoreIcon16,
  SettingsFillIcon16,
  SettingsIcon16,
  SortAlphabetAscIcon16,
  SortNumberDescIcon16,
} from "./icons"
import { Keys } from "./ui/keys"
import { NavListSkeleton } from "./ui/skeleton"
import {
  NoteActionsMenu,
  reorderEntries,
  useNoteMenuEntries,
  type ReorderActions,
} from "./note-actions-menu"
import { useBlockViewMenuEntries } from "./block-view-menu"
import { MenuItems, RowContextMenu } from "./block-editor/block-context-menu"
import { NoteFavicon } from "./note-favicon"
import { SettingsNavList } from "./settings/settings-nav"
import { beginGitHubSignIn } from "./github-auth"
import { SyncStatusIcon, useSyncStatusMeta, useSyncStatusText } from "./sync-status"
import { Tooltip } from "./ui/tooltip"

const SizeContext = createContext<"medium" | "large">("medium")

export function NavItems({
  size = "medium",
  onNavigate,
}: {
  size?: "medium" | "large"
  onNavigate?: () => void
}) {
  const views = useAtomValue(viewEntriesAtom)
  const sharedNotes = useAtomValue(sharedNotesAtom)
  const booting = useAtomValue(isBootingAtom)
  const syncText = useSyncStatusText()
  const syncMeta = useSyncStatusMeta()
  const { pathname } = useLocation()

  const today = new Date()
  const todayString = toDateString(today)

  // The Calendar link is current on any of the calendar's pages.
  const isCalendarActive = pathname === "/calendar" || pathname.startsWith("/calendar/")
  // While Settings is open its pages take the Views list's place, and only
  // that: the links above and the rows below stay where they are, so the
  // sidebar reads as one thing whose middle changed rather than a different
  // sidebar (src/components/settings/settings-nav.tsx).
  const inSettings = pathname === "/settings" || pathname.startsWith("/settings/")

  // Registered once by the app layout (src/hooks/app-update.ts).
  const { needRefresh, apply } = useAtomValue(appUpdateAtom)
  // Busy from the press until the reload: the waiting-update dot becomes the
  // spinner (docs/design-principles.md, "Busy controls").
  const [applyUpdate, updating] = usePending(apply)

  return (
    <SizeContext.Provider value={size}>
      <div className="flex grow flex-col justify-between gap-6">
        <div className="flex flex-col gap-2">
          <ul className="flex flex-col gap-1">
            <li>
              {/* Root first: the list of every note, the base of every pane
                  (src/data/root-frame.ts). The Views below are bookmarks. */}
              <NavLink
                to="/views/$"
                params={{ _splat: CORPUS_ROOT_ID }}
                search={{ query: undefined }}
                activeIcon={<GridFillIcon16 />}
                icon={<GridIcon16 />}
                shortcut={formatCombo(APP_SHORTCUTS.goRoot)}
                onNavigate={onNavigate}
              >
                {ROOT_LABEL}
              </NavLink>
            </li>
            <li>
              <NavLink
                to="/calendar/$"
                params={{ _splat: todayString }}
                search={{}}
                activeIcon={<CalendarDateFillIcon16 date={today.getDate()} />}
                icon={<CalendarDateIcon16 date={today.getDate()} />}
                forceActive={isCalendarActive}
                onNavigate={onNavigate}
              >
                Calendar
              </NavLink>
            </li>
          </ul>
          {/* The lists, each under its own heading — Views, Shared — with one
              rule above them, setting them off from the links above.

              Views is the one list of the user's own: every note, and every
              block made a view of its own (docs/metadata.md), in the order
              the sort menu says — and in the manual sort, the order it was
              dragged into, a block able to sit between two notes. A block's
              row opens its note focused on it. */}
          {inSettings ? (
            <div className="flex flex-col gap-1 border-t border-border-secondary pt-3">
              <SectionHeading>Settings</SectionHeading>
              <SettingsNavList size={size} />
            </div>
          ) : views.length > 0 ? (
            <div className="flex flex-col gap-1 border-t border-border-secondary pt-3">
              <SectionHeading action={<ViewSortMenu />}>Views</SectionHeading>
              <ViewRows entries={views} size={size} onNavigate={onNavigate} />
            </div>
          ) : booting ? (
            <NavListSkeleton />
          ) : null}
          {/* Notes other people shared with this account (docs/sharing.md):
              one list, whoever shared them, with who did in each row's
              tooltip and in the note page's header. They are listed apart
              from the user's own notes — they are rows in someone else's
              corpus — but open, read and edit as the verbs allow, like any note. */}
          {!inSettings && sharedNotes.length > 0 ? (
            <div className="flex flex-col gap-1 pt-2">
              <SectionHeading>Shared</SectionHeading>
              <NoteRows
                notes={sharedNotes.map(({ note }) => note)}
                titleOf={(note) => {
                  const entry = sharedNotes.find((shared) => shared.note.id === note.id)
                  if (!entry) return undefined
                  const verbs = entry.share.permissions.includes("write") ? "" : " · read only"
                  return `Shared by ${shareOwnerName(entry.share)}${verbs}`
                }}
                size={size}
                onNavigate={onNavigate}
              />
            </div>
          ) : null}
        </div>
        <div className="flex flex-col gap-1">
          {needRefresh ? (
            <button
              className="nav-item"
              data-size={size}
              disabled={updating}
              aria-busy={updating || undefined}
              onClick={applyUpdate}
            >
              {updating ? (
                <LoadingIcon16 />
              ) : (
                <div className="grid size-4 place-items-center [&>*]:row-span-full [&>*]:col-span-full">
                  <div className="size-3 rounded-full bg-border-focus opacity-50 animate-ping" />
                  <div className="size-2 rounded-full bg-border-focus" />
                </div>
              )}
              Update Ruminate
            </button>
          ) : null}
          {syncText === null ? null : (
            <Tooltip>
              <Tooltip.Trigger
                render={
                  syncMeta.action === null ? (
                    // Offline: nothing a click could do, so the row only
                    // states it — styled like its neighbours, with the
                    // default cursor.
                    <div className="nav-item text-text-secondary" data-size={size} data-static="">
                      <SyncStatusIcon />
                      {syncText}
                    </div>
                  ) : (
                    <button
                      className="nav-item text-text-secondary"
                      data-size={size}
                      onClick={() =>
                        // Pushes are automatic (write-behind); the button
                        // pulls the latest from D1 — or re-authenticates when
                        // the session died.
                        syncMeta.action === "reauth" ? beginGitHubSignIn() : requestDatabasePull()
                      }
                    >
                      <SyncStatusIcon />
                      {syncText}
                    </button>
                  )
                }
              />
              {syncMeta.tooltip ? (
                // The explanation behind the short label: a sentence, so it
                // wraps rather than running the width of the screen.
                <Tooltip.Content className="max-w-72 leading-snug text-balance">
                  {syncMeta.tooltip}
                </Tooltip.Content>
              ) : null}
            </Tooltip>
          )}
          {/* The places you go — each with the chord that gets there — then,
              set off beneath them, the two that explain the app: what it can
              do (Help) and what it just started doing (Changelog). They were
              interleaved with Settings and Admin before, which put the one
              row with no shortcut in the middle of the ones that had them. */}
          <NavLink
            to="/settings"
            search={{ query: undefined }}
            activeIcon={<SettingsFillIcon16 />}
            icon={<SettingsIcon16 />}
            className="text-text-secondary"
            // Marked on every settings page, not only the list at
            // `/settings`, and marked the way Help is while its panel is
            // open — the neutral pressed state, not the accent "current"
            // one — so the two rows at the foot of the sidebar that open
            // something over the notes read the same. On `/settings` itself
            // the Link adds `aria-current` as well; the pressed rules come
            // later in index.css and win.
            pressed={inSettings}
            shortcut={formatCombo(APP_SHORTCUTS.goSettings)}
            onNavigate={onNavigate}
          >
            Settings
          </NavLink>
          <div className="mt-1 flex flex-col gap-1 border-t border-border-secondary pt-2">
            <NavLink
              to="/changelog"
              search={{ release: undefined }}
              activeIcon={<HistoryFillIcon16 />}
              icon={<HistoryIcon16 />}
              className="text-text-secondary"
              shortcut={formatCombo(APP_SHORTCUTS.goChangelog)}
              onNavigate={onNavigate}
            >
              Changelog
            </NavLink>
            <HelpNavItem size={size} />
          </div>
        </div>
      </div>
    </SizeContext.Provider>
  )
}

/** A sidebar list's heading: quiet, in the row's inset, with room at its end
 * for a control belonging to the list beneath it (the Views sort). */
function SectionHeading({
  title,
  action,
  children,
}: {
  title?: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div
      className="flex h-6 items-center gap-2 px-2 text-sm text-text-secondary coarse:px-3"
      data-testid="section-heading"
      title={title}
    >
      <span className="truncate">{children}</span>
      {action ? <span className="ml-auto shrink-0">{action}</span> : null}
    </div>
  )
}

/** What each sort is called, and the icon that stands for it. */
const NOTE_SORTS: { value: NoteSort; label: string; icon: React.ReactNode }[] = [
  { value: "title", label: "Name", icon: <SortAlphabetAscIcon16 /> },
  { value: "updated", label: "Recently updated", icon: <SortNumberDescIcon16 /> },
  { value: "manual", label: "Manual", icon: <ListIcon16 /> },
]

/**
 * The Views list's sort, over the heading: one preference for the sidebar
 * and the palette (`noteSortAtom`), so no two surfaces
 * disagree about where a view is. **Manual** is what turns dragging on — a
 * drag in an automatic sort would be undone by the next render, so the rows
 * are only draggable once the order is the user's to set.
 */
function ViewSortMenu() {
  const [sort, setSort] = useAtom(noteSortAtom)
  const current = NOTE_SORTS.find((entry) => entry.value === sort) ?? NOTE_SORTS[0]
  return (
    <DropdownMenu modal={false}>
      <DropdownMenu.Trigger
        render={
          <IconButton aria-label={`Sort views by ${current.label.toLowerCase()}`} size="small">
            {current.icon}
          </IconButton>
        }
      />
      <DropdownMenu.Content align="end">
        <DropdownMenu.Group>
          <DropdownMenu.GroupLabel>Sort views</DropdownMenu.GroupLabel>
          {NOTE_SORTS.map((entry) => (
            <DropdownMenu.Item
              key={entry.value}
              icon={entry.icon}
              selected={sort === entry.value}
              onClick={() => setSort(entry.value)}
            >
              {entry.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Group>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}

/**
 * A nav row's leading icon: both variants are rendered and the row's
 * `aria-current` picks one, so the current row shows the filled icon in the
 * selected tint (`.nav-item-icon`, index.css) exactly as a nav link does.
 *
 * Every row in the sidebar's lists draws its icon through here, which is what
 * keeps a note row and a block row identical but for the glyph.
 */
function NavRowIcon({
  icon,
  filled,
  tint,
}: {
  icon: React.ReactNode
  filled: React.ReactNode
  /**
   * A colour the icon keeps **in both states**, current row included — for an
   * icon that reports something about the row rather than naming it. Left
   * out, the icon is ordinary secondary ink and hands itself to the row's own
   * colour when the row is current, as a favicon does.
   *
   * `nav-item-tint` is what exempts it from that hand-over (index.css); the
   * class and the colour always travel together, which is why the caller
   * passes a colour rather than setting the class itself.
   */
  tint?: string
}) {
  // Both variants take the tint: the filled one is what the CURRENT row
  // shows, which is exactly the case a tint exists to survive.
  const tinted = tint ? cx(tint, "nav-item-tint") : "text-text-secondary"
  return (
    <>
      <span className={cx("nav-item-icon hidden shrink-0", tinted, "[[aria-current=page]>&]:flex")}>
        {filled}
      </span>
      <span className={cx("nav-item-icon flex shrink-0", tinted, "[[aria-current=page]>&]:hidden")}>
        {icon}
      </span>
    </>
  )
}

/** The note rows of a list with no order of its own: the shared notes. */
function NoteRows({
  notes,
  titleOf,
  size,
  onNavigate,
}: {
  notes: Note[]
  /** A row's tooltip, where a list has one (who shared the note). */
  titleOf?: (note: Note) => string | undefined
  size: "medium" | "large"
  onNavigate?: () => void
}) {
  return (
    <ul className="flex flex-col gap-1">
      {notes.map((note) => (
        <li key={note.id} className="note-row group/note relative">
          {/* The note fills the row. Its actions button is not there
              until the row is hovered (or its menu is open): then it
              sits INSIDE the row's surface at the far end — the same
              distance from the surface's edge on every side, as the
              collapse chevron sits in a block's row — and the row
              pads its end (`.note-row` in index.css) so the name
              truncates with an ellipsis to make room rather than
              running under the button. The button is the row's
              sibling, not its child (a button cannot live in a
              link), so the same rules keep the row's hover surface
              while the pointer is on it. */}
          <NoteNavItem
            note={note}
            title={titleOf?.(note)}
            size={size}
            onNavigate={onNavigate}
            className="w-full"
          />
          <RowActions size={size}>
            <NoteActionsMenu noteId={note.id} />
          </RowActions>
        </li>
      ))}
    </ul>
  )
}

/**
 * The actions button's place at the end of a sidebar row (see `NoteRows`).
 *
 * Out of sight until the row is hovered, the button focused, or its menu
 * open — but never out of the LAYOUT: the menu is anchored to the button,
 * and it leaves with a short fade after its trigger has already dropped
 * `data-popup-open`. Were the wrapper `display: none` by then, the anchor
 * would have no box and the departing menu would snap to the page's corner
 * for the length of the fade. Opacity keeps the box; focus-within shows the
 * button to a keyboard, which `display: none` never could.
 */
function RowActions({ size, children }: { size: "medium" | "large"; children: React.ReactNode }) {
  return (
    <div
      className={cx(
        "absolute inset-y-0 flex items-center opacity-0 group-hover/note:opacity-100 focus-within:opacity-100 has-data-[popup-open]:opacity-100",
        // The 24px button in a 32px row (40px large) sits 4px
        // (8px) in from the top and bottom; the same from the end.
        size === "large" ? "right-2" : "right-1",
      )}
    >
      {children}
    </div>
  )
}

/** What a block view's row calls it: its text as one plain line (a row
 * renders no inline markdown), or a stand-in for none. */
const blockViewLabel = (block: BlockView): string => inlineText(block.text) || "Untitled block"

/**
 * **The Views list**: the notes and the block views as one list of rows
 * (`viewEntriesAtom`). Dragging is live only in the manual sort — in an
 * automatic one the next render would undo it — and the first drag is what
 * keys the list (docs/metadata.md); the row's menu moves it up and down for
 * the keyboard and for a touch screen, through the same write. There is no
 * band within the list to be stopped at: any row may be dropped anywhere,
 * a block above a note included.
 */
function ViewRows({
  entries,
  size,
  onNavigate,
}: {
  entries: ViewEntry[]
  size: "medium" | "large"
  onNavigate?: () => void
}) {
  const sort = useAtomValue(noteSortAtom)
  const manual = sort === "manual"
  const reorderViews = useReorderViews()
  const ids = React.useMemo(() => entries.map((entry) => entry.id), [entries])
  const onMove = React.useCallback(
    (_id: string, next: string[]) => reorderViews(next),
    [reorderViews],
  )
  const reorder = useDragReorder({ ids, onMove, enabled: manual })

  const swap = (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= entries.length) return undefined
    return () => {
      const next = [...ids]
      const [moved] = next.splice(index, 1)
      next.splice(target, 0, moved)
      reorderViews(next)
    }
  }

  return (
    <ul
      className="flex flex-col gap-1"
      data-testid="view-rows"
      {...(manual ? reorder.listProps : {})}
    >
      {entries.map((entry, index) => {
        const moves = manual ? { onMoveUp: swap(index, -1), onMoveDown: swap(index, 1) } : undefined
        return (
          <li
            key={entry.id}
            className={cx(
              "note-row group/note relative",
              manual && "data-[dragging]:opacity-40",
              reorder.dropBefore === entry.id &&
                "before:absolute before:-top-0.5 before:inset-x-0 before:h-0.5 before:rounded-full before:bg-border-focus",
              reorder.dropBefore === "end" &&
                index === entries.length - 1 &&
                "after:absolute after:-bottom-0.5 after:inset-x-0 after:h-0.5 after:rounded-full after:bg-border-focus",
            )}
            {...(manual ? reorder.rowProps(entry.id) : {})}
          >
            <ViewRowBody entry={entry} moves={moves} size={size} onNavigate={onNavigate} />
          </li>
        )
      })}
    </ul>
  )
}

/** Where a View row leads (docs/graph-walk.md, section 7): its stack restored
 * — Root, the saved frames, the top on screen — as a link, and the roots of
 * the frames beneath the top as the row's hint. */
interface ViewTarget {
  frames: FocusFrame[]
  params: { _splat: string }
  search: PaneSearch & { query: undefined }
  /** "Root › Tasks": empty for a one-frame View. */
  hint: string
}

function useViewTarget(entry: ViewEntry): ViewTarget {
  const graph = useAtomValue(graphSnapshotAtom)
  const row = useAtomValue(viewByRootAtom).get(entry.id)
  return React.useMemo(() => {
    const rootId = entry.id
    const noteId = entry.noteId
    const frames = restoreViewFrames({ rootId, noteId, stack: row?.stack }, graph) ?? [
      rootFrame(),
      { noteId, root: rootId === noteId ? null : rootId, selected: null },
    ]
    const { noteId: path, search } = layoutToSearch({ panes: [{ frames }], active: 0 })
    // Only what the link says: a key left undefined would keep the row from
    // matching the address it leads to.
    const said = Object.fromEntries(
      Object.entries(search).filter(([, value]) => value !== undefined),
    ) as PaneSearch
    const lower = frames.slice(1, -1)
    const labelOf = (frame: FocusFrame) =>
      inlineText(graph.nodes.get(frame.root ?? frame.noteId)?.text ?? "") || "Untitled"
    return {
      frames,
      params: { _splat: path },
      search: { ...said, query: undefined },
      hint: lower.length > 0 ? [ROOT_LABEL, ...lower.map(labelOf)].join(" › ") : "",
    }
  }, [entry.id, entry.noteId, row?.stack, graph])
}

/**
 * One View row: its link, its ⋯ button, and a right-click (or a
 * press-and-hold) on it that opens the same menu — rename, the moves, Remove
 * from Views and the rest — so the list is managed where it is drawn.
 */
function ViewRowBody({
  entry,
  moves,
  size,
  onNavigate,
}: {
  entry: ViewEntry
  moves?: ReorderActions
  size: "medium" | "large"
  onNavigate?: () => void
}) {
  const target = useViewTarget(entry)
  const noteEntriesFor = useNoteMenuEntries()
  const blockEntriesFor = useBlockViewMenuEntries()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  // Deleting the note on screen leads to Root, as the ⋯ menu does.
  const open = pathname.match(/^\/(?:views|boards)\/(.+)$/)
  const onDeleted =
    open && decodeURIComponent(open[1]) === entry.noteId
      ? () =>
          void navigate({
            to: "/views/$",
            params: { _splat: CORPUS_ROOT_ID },
            search: { query: undefined },
            replace: true,
          })
      : undefined
  const menu =
    entry.kind === "note"
      ? [...(moves ? reorderEntries(moves) : []), ...noteEntriesFor(entry.id, { onDeleted })]
      : blockEntriesFor(entry.block.id, entry.block.noteId, { reorder: moves })
  return (
    <RowContextMenu entries={menu}>
      {entry.kind === "note" ? (
        <NoteNavItem
          note={entry.note}
          target={target}
          size={size}
          onNavigate={onNavigate}
          className="w-full"
        />
      ) : (
        <BlockViewNavItem
          block={entry.block}
          target={target}
          size={size}
          onNavigate={onNavigate}
          className="w-full"
        />
      )}
      <RowActions size={size}>
        {entry.kind === "note" ? (
          <NoteActionsMenu noteId={entry.id} reorder={moves} />
        ) : (
          <BlockViewActionsMenu block={entry.block} reorder={moves} />
        )}
      </RowActions>
    </RowContextMenu>
  )
}

/** A View row's name, then its path hint in the secondary colour, clipped
 * to fit: "Todos  Root › Tasks" (docs/graph-walk.md, section 7). */
function RowName({ name, hint }: { name: string; hint?: string }) {
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className="truncate">{name}</span>
      {hint ? (
        <span data-testid="view-hint" className="min-w-0 truncate text-text-secondary">
          {hint}
        </span>
      ) : null}
    </span>
  )
}

/**
 * The glyph a block view's row leads with: the block's KEY — the very glyph
 * the block editor sets in the block's key slot (`BlockKey`: a bullet's
 * dot, a to-do's box, a heading's `#`, a paragraph's `¶`) — in the slot a
 * note's favicon takes, so the row says what kind of block it opens on the
 * way the row in the note does, and the sidebar and the palette never draw
 * a type two ways. The key takes the icon's ink (`[&_.block-glyph]`
 * below hands the glyphs `currentColor`, where in a row they carry their
 * own), so it leans with the label when the row is current, as a favicon
 * does. A figure has no key, its frame being its mark; in a list it has no
 * frame either, so its row falls back to the markdown that stands for it
 * (`typeGlyph`: a code fence, `![]`, `[]()`), mono and quiet.
 */
function BlockGlyph({ type }: { type: BlockType }) {
  if (!hasBlockKey(type)) {
    const glyph = typeGlyph(type)
    return (
      <span
        aria-hidden
        data-key={type}
        className="grid size-icon place-items-center overflow-visible whitespace-nowrap font-mono text-xs leading-none tracking-tight"
      >
        {glyph}
      </span>
    )
  }
  return (
    <span
      aria-hidden
      data-key={type}
      className={cx(
        "grid size-icon place-items-center font-content text-base leading-none [&_.block-glyph]:text-current [&_.block-glyph-fill]:bg-current",
        kindOf(type).slot === "hash" && "font-bold",
      )}
    >
      <BlockKey type={type} />
    </span>
  )
}

/** A block view's row: the block's marker glyph (`BlockGlyph`) and its text,
 * with the note it opens in as the row's tooltip. Current while its note is
 * open focused into it — the row's own link, exactly. */
function BlockViewNavItem({
  block,
  target,
  size,
  onNavigate,
  className,
}: {
  block: BlockView
  /** Where the View leads: its restored stack (`useViewTarget`). */
  target: ViewTarget
  size: "medium" | "large"
  onNavigate?: () => void
  className?: string
}) {
  const label = blockViewLabel(block)
  const openFramesInPane = useOpenFramesInPane()
  return (
    <Link
      to="/views/$"
      // The block's own saved view (docs/metadata.md) is applied by the note
      // page from the block's view row; the link carries the stack.
      params={target.params}
      search={target.search}
      activeOptions={{ exact: true, includeSearch: true }}
      data-size={size}
      className={cx("nav-item", className)}
      title={`${block.note.displayName} › ${label}`}
      onClick={(event) => {
        if (event.defaultPrevented) return
        // A split page opens it in the pane with the keyboard instead.
        if (isPlainClick(event) && openFramesInPane(target.frames)) event.preventDefault()
        onNavigate?.()
      }}
    >
      <NavRowIcon
        icon={<BlockGlyph type={block.type} />}
        filled={<BlockGlyph type={block.type} />}
      />
      {/* The same wrapper a note row's name sits in, so the two line up to
          the pixel down the list. */}
      <RowName name={label} hint={target.hint} />
    </Link>
  )
}

/** A block view's row menu: the block's menu away from its note
 * (`useBlockViewMenuEntries` — Copy, Copy link, Share, Remove from Views),
 * the list's moves ahead of it in the manual sort, as a note row has. */
function BlockViewActionsMenu({ block, reorder }: { block: BlockView; reorder?: ReorderActions }) {
  const entriesFor = useBlockViewMenuEntries()
  return (
    <DropdownMenu modal={false}>
      <DropdownMenu.Trigger
        render={
          <IconButton aria-label="Block view actions" size="small" disableTooltip>
            <MoreIcon16 />
          </IconButton>
        }
      />
      <DropdownMenu.Content align="start">
        <MenuItems entries={entriesFor(block.id, block.noteId, { reorder })} />
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}

/** The keys that reach a nav item, shown at its far end: quiet chrome, never
 * on a touch screen (where there are no keys to press). A chord (`g` then
 * `s`) reads as its keys in press order, as in the `?` reference. */
function NavShortcut({ keys, chord = false }: { keys: string[]; chord?: boolean }) {
  return (
    <span className="ml-auto shrink-0 pl-2 coarse:hidden">
      <Keys keys={keys} chord={chord} />
    </span>
  )
}

function NavLink({
  className,
  activeIcon,
  icon,
  includeSearch = false,
  forceActive = false,
  pressed = false,
  onNavigate,
  children,
  onClick,
  shortcut,
  ...props
}: LinkComponentProps<"a"> & {
  activeIcon?: React.ReactNode
  icon: React.ReactNode
  includeSearch?: boolean
  forceActive?: boolean
  /** Marked as Help is while open (`aria-pressed`, the neutral surface)
   * rather than as the current place; the filled icon shows either way. */
  pressed?: boolean
  onNavigate?: () => void
  children: React.ReactNode
  /** The keys that reach this destination (`formatCombo`), shown beside it. */
  shortcut?: string[]
}) {
  const size = useContext(SizeContext)

  const inner = (
    <>
      {activeIcon ? (
        <span className="hidden shrink-0 [[aria-current=page]>&]:flex [[aria-pressed=true]>&]:flex">
          {activeIcon}
        </span>
      ) : null}
      <span
        className={cx(
          "flex shrink-0 text-text-secondary",
          activeIcon && "[[aria-current=page]>&]:hidden [[aria-pressed=true]>&]:hidden",
        )}
      >
        {icon}
      </span>
      <span className="truncate">{children}</span>
      {shortcut ? <NavShortcut keys={shortcut} chord /> : null}
    </>
  )

  return (
    <Link
      activeOptions={{ exact: true, includeSearch }}
      data-size={size}
      className={cx("nav-item", className)}
      aria-current={forceActive ? "page" : undefined}
      aria-pressed={pressed || undefined}
      onClick={(event) => {
        onClick?.(event)
        if (!event.defaultPrevented) {
          onNavigate?.()
        }
      }}
      {...props}
    >
      {inner}
    </Link>
  )
}

/** A click that opens a link where it is: no modifier asking for a new tab
 * or window. */
const isPlainClick = (event: React.MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey

/** A note row in the sidebar list: its favicon and its display name. */
function NoteNavItem({
  note,
  title,
  target,
  size,
  onNavigate,
  className,
}: {
  note: Note
  title?: string
  /** Where a View row leads (`useViewTarget`); absent on a shared note's
   * row, which opens the note. */
  target?: ViewTarget
  size: "medium" | "large"
  onNavigate?: () => void
  className?: string
}) {
  const openFramesInPane = useOpenFramesInPane()
  const openInPane = useOpenInPane()
  // A board's row opens its board page (docs/boards.md), with nothing to
  // say about focus; every other note's its outline.
  if (note.type === "board") {
    return (
      <Link
        to="/boards/$"
        params={{ _splat: note.id }}
        activeOptions={{ exact: true }}
        data-size={size}
        className={cx("nav-item", className)}
        title={title}
        onClick={(event) => {
          if (!event.defaultPrevented) onNavigate?.()
        }}
      >
        <NavRowIcon
          icon={<NoteFavicon note={note} />}
          filled={<NoteFavicon note={note} filled />}
        />
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{note.displayName}</span>
        </span>
      </Link>
    )
  }
  return (
    <Link
      to="/views/$"
      params={target?.params ?? { _splat: note.id }}
      search={target?.search ?? { query: undefined }}
      // Current only at the note's ROOT. Focus is a place of its own — the
      // route calls `?block=` "the block the editor is focused on; absent =
      // outside focus" — and focused in, you are reading that block, not the
      // note whole. Matching the search is what draws that line: with no
      // block the searches are equal and the row is current; with one they
      // differ and it is not, so a block view's row is the only thing lit
      // rather than the block and its note at once.
      activeOptions={{ exact: true, includeSearch: true }}
      data-size={size}
      className={cx("nav-item", className)}
      title={title}
      onClick={(event) => {
        if (event.defaultPrevented) return
        // A split page opens it in the pane with the keyboard instead.
        // A View restores its stack there; a shared note is pushed on it.
        const open = () => (target ? openFramesInPane(target.frames) : openInPane(note.id))
        if (isPlainClick(event) && open()) event.preventDefault()
        onNavigate?.()
      }}
    >
      <NavRowIcon icon={<NoteFavicon note={note} />} filled={<NoteFavicon note={note} filled />} />
      {/* Show the note's name, matching the page header. Ids are minted and
          opaque now (docs/graph-storage.md), so the name is the title —
          which is what `displayName` resolves. */}
      <RowName name={note.displayName} hint={target?.hint} />
    </Link>
  )
}

function HelpNavItem({ size }: { size: "medium" | "large" }) {
  const [isOpen, setIsOpen] = useAtom(isHelpPanelOpenAtom)
  return (
    <button
      className="nav-item text-text-secondary"
      data-size={size}
      aria-pressed={isOpen}
      onClick={() => setIsOpen(!isOpen)}
    >
      {isOpen ? <CircleQuestionMarkFillIcon16 /> : <CircleQuestionMarkIcon16 />}
      Help
      <NavShortcut keys={formatCombo(APP_SHORTCUTS.helpPanel)} />
    </button>
  )
}
