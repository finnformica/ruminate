import { Link, LinkComponentProps, useLocation } from "@tanstack/react-router"
import copy from "copy-to-clipboard"
import { useAtom, useAtomValue } from "jotai"
import { createContext, useContext } from "react"
import { requestDatabasePull } from "../data/database-mode"
import { useIsAdmin } from "../data/features"
import {
  isBootingAtom,
  isHelpPanelOpenAtom,
  ownSortedNotesAtom,
  pinnedBlocksAtom,
  sharedNotesAtom,
  type PinnedBlock,
} from "../global-state"
import { appUpdateAtom } from "../hooks/app-update"
import { useSetBlockProps } from "../hooks/note"
import { shareOwnerName } from "../data/shares"
import type { Note } from "../schema"
import { APP_SHORTCUTS, formatCombo } from "../shortcuts/registry"
import { cx } from "../utils/cx"
import { inlineText } from "../utils/inline-text"
import { isValidDateString, isValidWeekString, toDateString } from "../utils/date"
import { DropdownMenu } from "./dropdown-menu"
import { IconButton } from "./icon-button"
import {
  CalendarDateFillIcon16,
  CalendarDateIcon16,
  CircleQuestionMarkFillIcon16,
  CircleQuestionMarkIcon16,
  CopyIcon16,
  FlagFillIcon16,
  FlagIcon16,
  HistoryIcon16,
  MoreIcon16,
  NoteFillIcon16,
  NoteIcon16,
  PinFillIcon12,
  PinFillIcon16,
  PinIcon16,
  SettingsFillIcon16,
  SettingsIcon16,
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
  const pinnedBlocks = useAtomValue(pinnedBlocksAtom)
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
                shortcut={formatCombo("g n")}
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
                shortcut={formatCombo("g d")}
                onNavigate={onNavigate}
              >
                Calendar
              </NavLink>
            </li>
          </ul>
          {/* The lists, each under its own heading — Notes, Pinned, Shared —
              with one rule above them all, setting them off from the links
              above. */}
          {notes.length > 0 ? (
            <div className="flex flex-col gap-1 border-t border-border-secondary pt-3">
              <SectionHeading>Notes</SectionHeading>
              <NoteRows notes={notes} size={size} onNavigate={onNavigate} />
            </div>
          ) : booting ? (
            <NavListSkeleton />
          ) : null}
          {/* The user's pinned BLOCKS (docs/metadata.md), between their notes
              and the notes shared with them: a pinned note is already at
              the top of the notes above, so this list is for blocks — each
              opens its note focused on the block. */}
          {pinnedBlocks.length > 0 ? (
            <div className="flex flex-col gap-1 pt-2">
              <SectionHeading>Pinned</SectionHeading>
              <PinnedBlockRows blocks={pinnedBlocks} size={size} onNavigate={onNavigate} />
            </div>
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
          {isAdmin ? (
            <NavLink
              to="/admin"
              search={{ query: undefined }}
              activeIcon={<FlagFillIcon16 />}
              icon={<FlagIcon16 />}
              className="text-text-secondary"
              shortcut={formatCombo("g a")}
              onNavigate={onNavigate}
            >
              Admin
            </NavLink>
          ) : null}
          <NavLink
            to="/changelog"
            search={{ release: undefined }}
            activeIcon={<HistoryIcon16 />}
            icon={<HistoryIcon16 />}
            className="text-text-secondary"
            onNavigate={onNavigate}
          >
            What's new
          </NavLink>
          <NavLink
            to="/settings"
            search={{ query: undefined }}
            activeIcon={<SettingsFillIcon16 />}
            icon={<SettingsIcon16 />}
            className="text-text-secondary"
            shortcut={formatCombo("g s")}
            onNavigate={onNavigate}
          >
            Settings
          </NavLink>
          <HelpNavItem size={size} />
        </div>
      </div>
    </SizeContext.Provider>
  )
}

/** A sidebar list's heading: quiet, in the row's inset. */
function SectionHeading({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div
      className="flex h-6 items-center gap-2 px-2 text-sm text-text-secondary coarse:px-3"
      title={title}
    >
      <span className="truncate">{children}</span>
    </div>
  )
}

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
            <NoteActionsMenu noteId={note.id} pinned={note.pinned} />
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

/** The pinned blocks, as rows: each opens its note focused on the block. */
function PinnedBlockRows({
  blocks,
  size,
  onNavigate,
}: {
  blocks: PinnedBlock[]
  size: "medium" | "large"
  onNavigate?: () => void
}) {
  return (
    <ul className="flex flex-col gap-1" data-testid="pinned-blocks">
      {blocks.map((block) => (
        <li key={block.id} className="note-row group/note relative">
          <PinnedBlockNavItem
            block={block}
            size={size}
            onNavigate={onNavigate}
            className="w-full"
          />
          <RowActions size={size}>
            <PinnedBlockActionsMenu block={block} />
          </RowActions>
        </li>
      ))}
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
      search={{ query: undefined, block: block.id }}
      activeOptions={{ exact: true, includeSearch: true }}
      data-size={size}
      className={cx("nav-item", className)}
      title={`${block.note.displayName} › ${label}`}
      onClick={(event) => {
        if (!event.defaultPrevented) onNavigate?.()
      }}
    >
      <span className="nav-item-icon hidden shrink-0 [[aria-current=page]>&]:flex">
        <PinFillIcon16 />
      </span>
      <span className="nav-item-icon flex shrink-0 text-text-secondary [[aria-current=page]>&]:hidden">
        <PinIcon16 />
      </span>
      <span className="truncate">{label}</span>
    </Link>
  )
}

/** A pinned block's row menu: unpin it, or copy a link to it. */
function PinnedBlockActionsMenu({ block }: { block: PinnedBlock }) {
  const setBlockProps = useSetBlockProps()
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
        <DropdownMenu.Item
          icon={<PinFillIcon16 className="text-text-pinned" />}
          onClick={() => setBlockProps(block.id, { pinned: null })}
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
  return (
    <Link
      to="/notes/$"
      params={{ _splat: note.id }}
      search={{ query: undefined }}
      activeOptions={{ exact: true, includeSearch: false }}
      data-size={size}
      className={cx("nav-item", className)}
      title={title}
      onClick={(event) => {
        if (!event.defaultPrevented) onNavigate?.()
      }}
    >
      {/* Current, the row shows the filled icon in its own tint
          (`.nav-item-icon`, index.css), exactly as a nav link swaps to its
          filled icon: both variants are rendered and the row's
          `aria-current` picks one. */}
      <span className="nav-item-icon hidden shrink-0 [[aria-current=page]>&]:flex">
        <NoteFavicon note={note} filled />
      </span>
      <span className="nav-item-icon flex shrink-0 text-text-secondary [[aria-current=page]>&]:hidden">
        <NoteFavicon note={note} />
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        {note.pinned ? <PinFillIcon12 className="shrink-0 text-text-pinned" /> : null}
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
