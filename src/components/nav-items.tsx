import { Link, LinkComponentProps, useLocation } from "@tanstack/react-router"
import copy from "copy-to-clipboard"
import { useAtom, useAtomValue } from "jotai"
import React, { createContext, useContext } from "react"
import { requestDatabasePull } from "../data/database-mode"
import { useIsAdmin } from "../data/features"
import {
  isBootingAtom,
  isHelpPanelOpenAtom,
  noteSortAtom,
  ownSortedNotesAtom,
  pinnedEntriesAtom,
  sharedNotesAtom,
  type NoteSort,
  type PinnedBlock,
  type PinnedEntry,
} from "../global-state"
import { appUpdateAtom } from "../hooks/app-update"
import { useMoveNote } from "../hooks/note"
import { useIsPinned, useReorderPinned, useWriteView } from "../hooks/views"
import { useDragReorder } from "../hooks/drag-reorder"
import { shareOwnerName } from "../data/shares"
import type { Note, NoteId } from "../schema"
import { APP_SHORTCUTS, formatCombo } from "../shortcuts/registry"
import { cx } from "../utils/cx"
import { inlineText } from "../utils/inline-text"
import { isValidDateString, isValidWeekString, toDateString } from "../utils/date"
import { DropdownMenu } from "./dropdown-menu"
import { IconButton } from "./icon-button"
import {
  ArrowDownIcon16,
  ArrowUpIcon16,
  CalendarDateFillIcon16,
  CalendarDateIcon16,
  CircleQuestionMarkFillIcon16,
  CircleQuestionMarkIcon16,
  CopyIcon16,
  FlagFillIcon16,
  FlagIcon16,
  HistoryIcon16,
  ListIcon16,
  MoreIcon16,
  NoteFillIcon16,
  NoteIcon16,
  PinFillIcon16,
  PinIcon16,
  SettingsFillIcon16,
  SettingsIcon16,
  SortAlphabetAscIcon16,
  SortNumberDescIcon16,
} from "./icons"
import { Keys } from "./keys"
import { NavListSkeleton } from "./skeleton"
import { NoteActionsMenu } from "./note-actions-menu"
import { NoteFavicon } from "./note-favicon"
import { beginGitHubSignIn } from "./github-auth"
import { SyncStatusIcon, useSyncStatusMeta, useSyncStatusText } from "./sync-status"
import { Tooltip } from "./tooltip"

const SizeContext = createContext<"medium" | "large">("medium")

export function NavItems({
  size = "medium",
  onNavigate,
}: {
  size?: "medium" | "large"
  onNavigate?: () => void
}) {
  const notes = useAtomValue(ownSortedNotesAtom)
  const pinned = useAtomValue(pinnedEntriesAtom)
  const sharedNotes = useAtomValue(sharedNotesAtom)
  const booting = useAtomValue(isBootingAtom)
  const syncText = useSyncStatusText()
  const syncMeta = useSyncStatusMeta()
  const { pathname } = useLocation()

  const today = new Date()
  const todayString = toDateString(today)

  // Calendar link is active when viewing any daily or weekly note
  const noteId = pathname.startsWith("/notes/") ? pathname.slice(7) : ""
  const isCalendarActive = isValidDateString(noteId) || isValidWeekString(noteId)

  // Registered once by the app layout (src/hooks/app-update.ts).
  const { needRefresh, apply: applyUpdate } = useAtomValue(appUpdateAtom)

  // The admin page (invites, feature flags) is the bootstrap owner's alone,
  // as the server says (src/data/features.ts); nobody else sees the link.
  const isAdmin = useIsAdmin()

  return (
    <SizeContext.Provider value={size}>
      <div className="flex grow flex-col justify-between gap-6">
        <div className="flex flex-col gap-2">
          <ul className="flex flex-col gap-1">
            <li>
              <NavLink
                to="/"
                search={{ query: undefined }}
                activeIcon={<NoteFillIcon16 />}
                icon={<NoteIcon16 />}
                shortcut={formatCombo(APP_SHORTCUTS.goNotes)}
                onNavigate={onNavigate}
              >
                Notes
              </NavLink>
            </li>
            <li>
              <NavLink
                to="/notes/$"
                params={{ _splat: todayString }}
                search={{
                  query: undefined,
                }}
                activeIcon={<CalendarDateFillIcon16 date={today.getDate()} />}
                icon={<CalendarDateIcon16 date={today.getDate()} />}
                forceActive={isCalendarActive}
                shortcut={formatCombo(APP_SHORTCUTS.goCalendar)}
                onNavigate={onNavigate}
              >
                Calendar
              </NavLink>
            </li>
          </ul>
          {/* The lists, each under its own heading — Views, Notes, Shared —
              with one rule above them all, setting them off from the links
              above.

              Views leads: it is what you keep to hand, and it holds both
              kinds of pin (docs/metadata.md) — notes and blocks in one list,
              in the order it was dragged into, a block opening its note
              focused on it. A pinned note is ALSO still in Notes below, in
              its sorted place: the pin is somewhere else to reach it, not
              somewhere it has gone. */}
          {pinned.length > 0 ? (
            <div className="flex flex-col gap-1 border-t border-border-secondary pt-3">
              <SectionHeading>Views</SectionHeading>
              <ViewRows entries={pinned} size={size} onNavigate={onNavigate} />
            </div>
          ) : null}
          {notes.length > 0 ? (
            <div
              className={cx(
                "flex flex-col gap-1",
                // The rule belongs to whichever list is first.
                pinned.length > 0 ? "pt-2" : "border-t border-border-secondary pt-3",
              )}
            >
              <SectionHeading action={<NoteSortMenu />}>Notes</SectionHeading>
              <OwnNoteRows notes={notes} size={size} onNavigate={onNavigate} />
            </div>
          ) : booting ? (
            <NavListSkeleton />
          ) : null}
          {/* Notes other people shared with this account (docs/sharing.md):
              one list, whoever shared them, with who did in each row's
              tooltip and in the note page's header. They are listed apart
              from the user's own notes — they are rows in someone else's
              corpus — but open, read and edit as the verbs allow, like any note. */}
          {sharedNotes.length > 0 ? (
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
            <button className="nav-item" data-size={size} onClick={applyUpdate}>
              <div className="grid size-4 place-items-center [&>*]:row-span-full [&>*]:col-span-full">
                <div className="size-3 rounded-full bg-border-focus opacity-50 animate-ping" />
                <div className="size-2 rounded-full bg-border-focus" />
              </div>
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
            shortcut={formatCombo(APP_SHORTCUTS.goSettings)}
            onNavigate={onNavigate}
          >
            Settings
          </NavLink>
          {isAdmin ? (
            <NavLink
              to="/admin"
              search={{ query: undefined }}
              activeIcon={<FlagFillIcon16 />}
              icon={<FlagIcon16 />}
              className="text-text-secondary"
              shortcut={formatCombo(APP_SHORTCUTS.goAdmin)}
              onNavigate={onNavigate}
            >
              Admin
            </NavLink>
          ) : null}
          <div className="mt-1 flex flex-col gap-1 border-t border-border-secondary pt-2">
            <NavLink
              to="/changelog"
              search={{ release: undefined }}
              activeIcon={<HistoryIcon16 />}
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
 * for a control belonging to the list beneath it (the Notes sort). */
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
 * The Notes list's sort, over the heading: one preference for the sidebar and
 * the notes page both (`noteSortAtom`), so the two never disagree about where
 * a note is. **Manual** is what turns dragging on — a drag in an automatic
 * sort would be undone by the next render, so the rows are only draggable
 * once the order is the user's to set.
 */
function NoteSortMenu() {
  const [sort, setSort] = useAtom(noteSortAtom)
  const current = NOTE_SORTS.find((entry) => entry.value === sort) ?? NOTE_SORTS[0]
  return (
    <DropdownMenu modal={false}>
      <DropdownMenu.Trigger
        render={
          <IconButton aria-label={`Sort notes by ${current.label.toLowerCase()}`} size="small">
            {current.icon}
          </IconButton>
        }
      />
      <DropdownMenu.Content align="end">
        <DropdownMenu.Group>
          <DropdownMenu.GroupLabel>Sort notes</DropdownMenu.GroupLabel>
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
 * The user's own notes, which are the only rows that reorder: a shared note
 * is a row in someone else's corpus, so there is no link of ours to key it by
 * (docs/sharing.md).
 *
 * Dragging is live only in the manual sort: in an automatic one the next
 * render would undo it. There is no band within the list to be stopped at —
 * a pin lists a note under **Views** above, and leaves its place here
 * untouched — so any row may be dropped anywhere.
 */
function OwnNoteRows({
  notes,
  size,
  onNavigate,
}: {
  notes: Note[]
  size: "medium" | "large"
  onNavigate?: () => void
}) {
  const sort = useAtomValue(noteSortAtom)
  const moveNote = useMoveNote()
  const manual = sort === "manual"

  const ids = React.useMemo(() => notes.map((note) => note.id), [notes])
  const onMove = React.useCallback((id: NoteId, next: NoteId[]) => moveNote(id, next), [moveNote])
  const reorder = useDragReorder({ ids, onMove, enabled: manual })

  // The keyboard's way to the same move (`NoteActionsMenu`), swapping a row
  // with its neighbour.
  const swap = (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= notes.length) return undefined
    return () => {
      const next = [...ids]
      const [moved] = next.splice(index, 1)
      next.splice(target, 0, moved)
      moveNote(ids[index], next)
    }
  }

  return (
    <ul
      className="flex flex-col gap-1"
      data-testid="note-rows"
      {...(manual ? reorder.listProps : {})}
    >
      {notes.map((note, index) => {
        const rowProps = manual ? reorder.rowProps(note.id) : null
        return (
          <li
            key={note.id}
            className={cx(
              "note-row group/note relative",
              manual && "data-[dragging]:opacity-40",
              reorder.dropBefore === note.id &&
                "before:absolute before:-top-0.5 before:inset-x-0 before:h-0.5 before:rounded-full before:bg-border-focus",
              reorder.dropBefore === "end" &&
                index === notes.length - 1 &&
                "after:absolute after:-bottom-0.5 after:inset-x-0 after:h-0.5 after:rounded-full after:bg-border-focus",
            )}
            {...rowProps}
          >
            <NoteNavItem note={note} size={size} onNavigate={onNavigate} className="w-full" />
            <RowActions size={size}>
              <NoteActionsMenu
                noteId={note.id}
                reorder={
                  manual ? { onMoveUp: swap(index, -1), onMoveDown: swap(index, 1) } : undefined
                }
              />
            </RowActions>
          </li>
        )
      })}
    </ul>
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

/**
 * **What a pinned row leads with**, a note and a block alike: the pin, in the
 * pinned tint.
 *
 * It replaces the row's own icon rather than sitting beside it. A nav row is
 * a name and one glyph; the glyph is the only thing there to carry the state,
 * and a favicon saying which kind of note this is earns the slot rather less
 * than the pin does. Two glyphs to say one row would be a crowded way to say
 * it.
 *
 * **The leading pin is the sidebar's alone.** Where the block editor draws a
 * row — the notes page, the palette, a search result — the pin trails the
 * content instead (`block-item.tsx`, docs/metadata.md): those rows are
 * blocks, drawn to one rhythm with a shared text column, and the head slot is
 * already spoken for by the marker that says what the row is, or by the fold
 * chevron the moment it has anything in it.
 */
const pinRowIcon = (
  <NavRowIcon icon={<PinIcon16 />} filled={<PinFillIcon16 />} tint="text-text-pinned" />
)

/** The note rows of one list: the user's own, or the shared ones. */
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

/** The actions button's place at the end of a sidebar row (see `NoteRows`). */
function RowActions({ size, children }: { size: "medium" | "large"; children: React.ReactNode }) {
  return (
    <div
      className={cx(
        "absolute inset-y-0 hidden items-center group-hover/note:flex has-data-[popup-open]:flex",
        // The 24px button in a 32px row (40px large) sits 4px
        // (8px) in from the top and bottom; the same from the end.
        size === "large" ? "right-2" : "right-1",
      )}
    >
      {children}
    </div>
  )
}

/** What a pinned block's row calls it: its text as one plain line (a row
 * renders no inline markdown), or a stand-in for none. */
const pinnedBlockLabel = (block: PinnedBlock): string => inlineText(block.text) || "Untitled block"

/**
 * **The Views list**: the pinned notes and blocks as one list of rows, in
 * the order it was dragged into (`pinnedEntriesAtom`). Dragging is always
 * live here — the list has no sort but the user's own — and the first drag
 * is what keys the list (docs/metadata.md); the row's menu moves it up and
 * down for the keyboard and for a touch screen, through the same write.
 */
function ViewRows({
  entries,
  size,
  onNavigate,
}: {
  entries: PinnedEntry[]
  size: "medium" | "large"
  onNavigate?: () => void
}) {
  const reorderPinned = useReorderPinned()
  const ids = React.useMemo(() => entries.map((entry) => entry.id), [entries])
  const onMove = React.useCallback(
    (_id: string, next: string[]) => reorderPinned(next),
    [reorderPinned],
  )
  const reorder = useDragReorder({ ids, onMove })

  const swap = (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= entries.length) return undefined
    return () => {
      const next = [...ids]
      const [moved] = next.splice(index, 1)
      next.splice(target, 0, moved)
      reorderPinned(next)
    }
  }

  return (
    <ul className="flex flex-col gap-1" data-testid="view-rows" {...reorder.listProps}>
      {entries.map((entry, index) => {
        const moves = { onMoveUp: swap(index, -1), onMoveDown: swap(index, 1) }
        return (
          <li
            key={entry.id}
            className={cx(
              "note-row group/note relative data-[dragging]:opacity-40",
              reorder.dropBefore === entry.id &&
                "before:absolute before:-top-0.5 before:inset-x-0 before:h-0.5 before:rounded-full before:bg-border-focus",
              reorder.dropBefore === "end" &&
                index === entries.length - 1 &&
                "after:absolute after:-bottom-0.5 after:inset-x-0 after:h-0.5 after:rounded-full after:bg-border-focus",
            )}
            {...reorder.rowProps(entry.id)}
          >
            {entry.kind === "note" ? (
              <>
                <NoteNavItem
                  note={entry.note}
                  size={size}
                  onNavigate={onNavigate}
                  className="w-full"
                />
                <RowActions size={size}>
                  <NoteActionsMenu noteId={entry.id} reorder={moves} />
                </RowActions>
              </>
            ) : (
              <>
                <PinnedBlockNavItem
                  block={entry.block}
                  size={size}
                  onNavigate={onNavigate}
                  className="w-full"
                />
                <RowActions size={size}>
                  <PinnedBlockActionsMenu block={entry.block} reorder={moves} />
                </RowActions>
              </>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** A pinned block's row: the pin, and the block's text, with the note it
 * opens in as the row's tooltip. Current while its note is open focused
 * into it — the row's own link, exactly. */
function PinnedBlockNavItem({
  block,
  size,
  onNavigate,
  className,
}: {
  block: PinnedBlock
  size: "medium" | "large"
  onNavigate?: () => void
  className?: string
}) {
  const label = pinnedBlockLabel(block)
  return (
    <Link
      to="/notes/$"
      params={{ _splat: block.noteId }}
      // The block's own saved view (docs/metadata.md) is applied by the note
      // page from the block's props, so the link carries only where to go.
      search={{ query: undefined, block: block.id }}
      activeOptions={{ exact: true, includeSearch: true }}
      data-size={size}
      className={cx("nav-item", className)}
      title={`${block.note.displayName} › ${label}`}
      onClick={(event) => {
        if (!event.defaultPrevented) onNavigate?.()
      }}
    >
      {pinRowIcon}
      {/* The same wrapper a note row's name sits in, so the two line up to
          the pixel down the list. */}
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate">{label}</span>
      </span>
    </Link>
  )
}

/** A pinned block's row menu: move it within Views (the keyboard's and a
 * touch screen's way to reorder), unpin it, or copy a link to it. */
function PinnedBlockActionsMenu({
  block,
  reorder,
}: {
  block: PinnedBlock
  reorder?: { onMoveUp?: () => void; onMoveDown?: () => void }
}) {
  const writeView = useWriteView()
  return (
    <DropdownMenu modal={false}>
      <DropdownMenu.Trigger
        render={
          <IconButton aria-label="Pinned block actions" size="small" disableTooltip>
            <MoreIcon16 />
          </IconButton>
        }
      />
      <DropdownMenu.Content align="start">
        {reorder ? (
          <>
            <DropdownMenu.Item
              icon={<ArrowUpIcon16 />}
              disabled={!reorder.onMoveUp}
              onClick={() => reorder.onMoveUp?.()}
            >
              Move up
            </DropdownMenu.Item>
            <DropdownMenu.Item
              icon={<ArrowDownIcon16 />}
              disabled={!reorder.onMoveDown}
              onClick={() => reorder.onMoveDown?.()}
            >
              Move down
            </DropdownMenu.Item>
            <DropdownMenu.Separator />
          </>
        ) : null}
        <DropdownMenu.Item
          icon={<PinFillIcon16 className="text-text-pinned" />}
          onClick={() => writeView(block.id, { pinned: false })}
        >
          Unpin
        </DropdownMenu.Item>
        <DropdownMenu.Item
          icon={<CopyIcon16 />}
          onClick={() => copy(`${window.location.origin}/notes/${block.noteId}?block=${block.id}`)}
        >
          Copy link to block
        </DropdownMenu.Item>
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
  onNavigate?: () => void
  children: React.ReactNode
  /** The keys that reach this destination (`formatCombo`), shown beside it. */
  shortcut?: string[]
}) {
  const size = useContext(SizeContext)

  const inner = (
    <>
      {activeIcon ? (
        <span className="hidden shrink-0 [[aria-current=page]>&]:flex">{activeIcon}</span>
      ) : null}
      <span
        className={cx(
          "flex shrink-0 text-text-secondary",
          activeIcon && "[[aria-current=page]>&]:hidden",
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

/** A note row in the sidebar list: favicon, an optional pin marker, and the
 * note's display name. Pinned notes sort to the top (see sortedNotesAtom). */
function NoteNavItem({
  note,
  title,
  size,
  onNavigate,
  className,
}: {
  note: Note
  title?: string
  size: "medium" | "large"
  onNavigate?: () => void
  className?: string
}) {
  const pinned = useIsPinned(note.id)
  return (
    <Link
      to="/notes/$"
      params={{ _splat: note.id }}
      search={{ query: undefined }}
      // Current only at the note's ROOT. Focus is a place of its own — the
      // route calls `?block=` "the block the editor is focused on; absent =
      // outside focus" — and focused in, you are reading that block, not the
      // note whole. Matching the search is what draws that line: with no
      // block the searches are equal and the row is current; with one they
      // differ and it is not, so a pinned block's row is the only thing lit
      // rather than the block and its note at once.
      activeOptions={{ exact: true, includeSearch: true }}
      data-size={size}
      className={cx("nav-item", className)}
      title={title}
      onClick={(event) => {
        if (!event.defaultPrevented) onNavigate?.()
      }}
    >
      {/* Pinned, the row wears the pin instead of its favicon — in every
          list, not just under **Views**, so a note looks the same wherever
          it is listed and one glance says which notes are pinned. */}
      {pinned ? (
        pinRowIcon
      ) : (
        <NavRowIcon
          icon={<NoteFavicon note={note} />}
          filled={<NoteFavicon note={note} filled />}
        />
      )}
      <span className="flex min-w-0 items-center gap-1.5">
        {/* Show the note's name, matching the page header. Ids are minted and
            opaque now (docs/graph-storage.md), so the name is the
            title — which is what `displayName` resolves. */}
        <span className="truncate">{note.displayName}</span>
      </span>
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
