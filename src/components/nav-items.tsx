import { Link, LinkComponentProps, useLocation } from "@tanstack/react-router"
import { useAtom, useAtomValue } from "jotai"
import { createContext, useContext } from "react"
import { useNetworkState } from "react-use"
import { useRegisterSW } from "virtual:pwa-register/react"
import { requestDatabasePull } from "../data/database-mode"
import { isHelpPanelOpenAtom, sortedNotesAtom } from "../global-state"
import type { Note } from "../schema"
import { cx } from "../utils/cx"
import { isValidDateString, isValidWeekString, toDateString } from "../utils/date"
import {
  CalendarDateFillIcon16,
  CalendarDateIcon16,
  CircleQuestionMarkFillIcon16,
  CircleQuestionMarkIcon16,
  NoteFillIcon16,
  NoteIcon16,
  OfflineIcon16,
  PinFillIcon12,
  SettingsFillIcon16,
  SettingsIcon16,
  TagFillIcon16,
  TagIcon16,
} from "./icons"
import { NoteActionsMenu } from "./note-actions-menu"
import { NoteFavicon } from "./note-favicon"
import { beginGitHubSignIn } from "./github-auth"
import { SyncStatusIcon, useSyncStatusMeta, useSyncStatusText } from "./sync-status"

const SizeContext = createContext<"medium" | "large">("medium")

export function NavItems({
  size = "medium",
  onNavigate,
}: {
  size?: "medium" | "large"
  onNavigate?: () => void
}) {
  const notes = useAtomValue(sortedNotesAtom)
  const syncText = useSyncStatusText()
  const syncMeta = useSyncStatusMeta()
  const { online } = useNetworkState()
  const { pathname } = useLocation()

  const today = new Date()
  const todayString = toDateString(today)

  // Calendar link is active when viewing any daily or weekly note
  const noteId = pathname.startsWith("/notes/") ? pathname.slice(7) : ""
  const isCalendarActive = isValidDateString(noteId) || isValidWeekString(noteId)

  // Reference: https://vite-pwa-org.netlify.app/frameworks/react.html#prompt-for-update
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegistered(registration) {
      console.log("SW registered: " + registration)

      if (registration) {
        // Check for updates every hour
        setInterval(
          () => {
            registration.update()
          },
          60 * 60 * 1000,
        )
      }
    },
    onRegisterError(error) {
      console.error("SW registration error", error)
    },
  })

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
                onNavigate={onNavigate}
              >
                Calendar
              </NavLink>
            </li>
            <li>
              {/* Tags view isn't ready yet — shown disabled as a reminder to revisit. */}
              <NavLink
                to="/tags"
                search={{ query: undefined, sort: "name" }}
                activeIcon={<TagFillIcon16 />}
                icon={<TagIcon16 />}
                onNavigate={onNavigate}
                disabled
              >
                Tags
              </NavLink>
            </li>
          </ul>
          {notes.length > 0 ? (
            <ul className="flex flex-col gap-1 border-t border-border-secondary pt-3">
              {notes.map((note) => (
                <li key={note.id} className="group/note flex items-center">
                  {/* The note fills the row; on hover the actions menu takes its
                      own space to the right (a real flex sibling), so the note
                      name truncates with an ellipsis to make room rather than
                      sitting under the button. The menu stays visible while its
                      dropdown is open. */}
                  <NoteNavItem note={note} size={size} onNavigate={onNavigate} />
                  <div className="hidden shrink-0 pl-0.5 group-hover/note:flex has-data-[popup-open]:flex">
                    <NoteActionsMenu noteId={note.id} content={note.content} pinned={note.pinned} />
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="flex flex-col gap-1">
          {needRefresh ? (
            <button
              className="nav-item"
              data-size={size}
              onClick={() => {
                // Apply the waiting service worker and reload to the new
                // version. Fall back to a hard reload if the worker never
                // takes over (so the button always refreshes the app).
                void updateServiceWorker(true)
                window.setTimeout(() => window.location.reload(), 3000)
              }}
            >
              <div className="grid size-4 place-items-center [&>*]:row-span-full [&>*]:col-span-full">
                <div className="size-3 rounded-full bg-border-focus opacity-50 animate-ping" />
                <div className="size-2 rounded-full bg-border-focus" />
              </div>
              Update Ruminate
            </button>
          ) : null}
          {!online ? (
            <div className="nav-item text-text-secondary" data-size={size}>
              <OfflineIcon16 />
              Offline
            </div>
          ) : null}
          {syncText ? (
            <button
              className="nav-item text-text-secondary"
              data-size={size}
              title={syncMeta.tooltip}
              onClick={() =>
                // Pushes are automatic (write-behind); the button pulls the
                // latest from D1 — or re-authenticates when the session died.
                syncMeta.needsReauth ? beginGitHubSignIn() : requestDatabasePull()
              }
            >
              <SyncStatusIcon />
              {syncText}
            </button>
          ) : null}
          <NavLink
            to="/settings"
            search={{ query: undefined }}
            activeIcon={<SettingsFillIcon16 />}
            icon={<SettingsIcon16 />}
            className="text-text-secondary"
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

function NavLink({
  className,
  activeIcon,
  icon,
  includeSearch = false,
  forceActive = false,
  onNavigate,
  children,
  onClick,
  disabled = false,
  ...props
}: LinkComponentProps<"a"> & {
  activeIcon?: React.ReactNode
  icon: React.ReactNode
  includeSearch?: boolean
  forceActive?: boolean
  onNavigate?: () => void
  children: React.ReactNode
  /** Render a non-interactive, greyed-out item (feature not ready yet). */
  disabled?: boolean
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
    </>
  )

  if (disabled) {
    return (
      <div
        data-size={size}
        aria-disabled="true"
        title="Coming soon"
        className={cx("nav-item cursor-not-allowed opacity-50", className)}
      >
        {inner}
      </div>
    )
  }

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
  size,
  onNavigate,
  className,
}: {
  note: Note
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
      className={cx("nav-item w-0 flex-1", className)}
      onClick={(event) => {
        if (!event.defaultPrevented) onNavigate?.()
      }}
    >
      <span className="flex shrink-0 text-text-secondary">
        <NoteFavicon note={note} />
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        {note.pinned ? <PinFillIcon12 className="shrink-0 text-text-pinned" /> : null}
        {/* Show the note's name, matching the page header. Ids are minted and
            opaque now (docs/page-identity-design.md), so the name is the
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
    </button>
  )
}
