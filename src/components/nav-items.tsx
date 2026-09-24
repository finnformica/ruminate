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
  sharedNotesAtom,
  viewEntriesAtom,
  type BlockView,
  type NoteSort,
  type ViewEntry,
} from "../global-state"
import { appUpdateAtom } from "../hooks/app-update"
import { usePending } from "../hooks/pending"
import { REMOVE_VIEW, useReorderViews, useWriteView } from "../hooks/views"
import { useDragReorder } from "../hooks/drag-reorder"
import { shareOwnerName } from "../data/shares"
import type { Note } from "../schema"
import { APP_SHORTCUTS, formatCombo } from "../shortcuts/registry"
import { cx } from "../utils/cx"
import { inlineText } from "../utils/inline-text"
import { isValidDateString, isValidWeekString, toDateString } from "../utils/date"
import { DropdownMenu } from "./ui/dropdown-menu"
import { IconButton } from "./ui/icon-button"
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
  FocusIcon16,
  GridIcon16,
  HistoryIcon16,
  ListIcon16,
  LoadingIcon16,
  MoreIcon16,
  SettingsFillIcon16,
  SettingsIcon16,
  SortAlphabetAscIcon16,
  SortNumberDescIcon16,
  XIcon16,
} from "./icons"
import { Keys } from "./ui/keys"
import { NavListSkeleton } from "./ui/skeleton"
import { NoteActionsMenu } from "./note-actions-menu"
import { NoteFavicon } from "./note-favicon"
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

  // Calendar link is active when viewing any daily or weekly note
  const noteId = pathname.startsWith("/views/") ? pathname.slice(7) : ""
  const isCalendarActive = isValidDateString(noteId) || isValidWeekString(noteId)

  // Registered once by the app layout (src/hooks/app-update.ts).
  const { needRefresh, apply } = useAtomValue(appUpdateAtom)
  // Busy from the press until the reload: the waiting-update dot becomes the
  // spinner (docs/design-principles.md, "Busy controls").
  const [applyUpdate, updating] = usePending(apply)

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
                activeIcon={<GridIcon16 />}
                icon={<GridIcon16 />}
                shortcut={formatCombo(APP_SHORTCUTS.goViews)}
                onNavigate={onNavigate}
              >
                Views
              </NavLink>
            </li>
            <li>
              <NavLink
                to="/views/$"
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
          {/* The lists, each under its own heading — Views, Shared — with one
              rule above them, setting them off from the links above.

              Views is the one list of the user's own: every note, and every
              block made a view of its own (docs/metadata.md), in the order
              the sort menu says — and in the manual sort, the order it was
              dragged into, a block able to sit between two notes. A block's
              row opens its note focused on it. */}
          {views.length > 0 ? (
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
 * The Views list's sort, over the heading: one preference for the sidebar,
 * the Views page and the palette (`noteSortAtom`), so no two surfaces
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
                <BlockViewNavItem
                  block={entry.block}
                  size={size}
                  onNavigate={onNavigate}
                  className="w-full"
                />
                <RowActions size={size}>
                  <BlockViewActionsMenu block={entry.block} reorder={moves} />
                </RowActions>
              </>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** A block view's row: the focus glyph — the row opens its note focused on
 * the block, and this is the glyph focusing wears elsewhere — and the
 * block's text, with the note it opens in as the row's tooltip. Current
 * while its note is open focused into it — the row's own link, exactly. */
function BlockViewNavItem({
  block,
  size,
  onNavigate,
  className,
}: {
  block: BlockView
  size: "medium" | "large"
  onNavigate?: () => void
  className?: string
}) {
  const label = blockViewLabel(block)
  return (
    <Link
      to="/views/$"
      params={{ _splat: block.noteId }}
      // The block's own saved view (docs/metadata.md) is applied by the note
      // page from the block's view row, so the link carries only where to go.
      search={{ query: undefined, block: block.id }}
      activeOptions={{ exact: true, includeSearch: true }}
      data-size={size}
      className={cx("nav-item", className)}
      title={`${block.note.displayName} › ${label}`}
      onClick={(event) => {
        if (!event.defaultPrevented) onNavigate?.()
      }}
    >
      <NavRowIcon icon={<FocusIcon16 />} filled={<FocusIcon16 />} />
      {/* The same wrapper a note row's name sits in, so the two line up to
          the pixel down the list. */}
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate">{label}</span>
      </span>
    </Link>
  )
}

/** A block view's row menu: move it within Views (the keyboard's and a
 * touch screen's way to reorder), take it out of Views, or copy a link to
 * it. */
function BlockViewActionsMenu({
  block,
  reorder,
}: {
  block: BlockView
  reorder?: { onMoveUp?: () => void; onMoveDown?: () => void }
}) {
  const writeView = useWriteView()
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
        <DropdownMenu.Item icon={<XIcon16 />} onClick={() => writeView(block.id, REMOVE_VIEW)}>
          Remove from Views
        </DropdownMenu.Item>
        <DropdownMenu.Item
          icon={<CopyIcon16 />}
          onClick={() => copy(`${window.location.origin}/views/${block.noteId}?block=${block.id}`)}
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

/** A note row in the sidebar list: its favicon and its display name. */
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
  return (
    <Link
      to="/views/$"
      params={{ _splat: note.id }}
      search={{ query: undefined }}
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
        if (!event.defaultPrevented) onNavigate?.()
      }}
    >
      <NavRowIcon icon={<NoteFavicon note={note} />} filled={<NoteFavicon note={note} filled />} />
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
