import { useAtomValue } from "jotai"
import { LoadingIcon16 } from "../components/icons"
import { RepoForm } from "../components/repo-form"
import { databaseModeStatusAtom } from "../data/database-mode"
import {
  githubRepoAtom,
  isCloningRepoAtom,
  isDatabaseModeAtom,
  isRepoNotClonedAtom,
  isSignedOutAtom,
  notesReadyAtom,
} from "../global-state"
import { cx } from "../utils/cx"
import { PageHeader, PageHeaderProps } from "./page-header"
import { HoverCard } from "./hover-card"
import { Notice } from "./notice"

type PageLayoutProps = PageHeaderProps & {
  className?: string
  disableGuard?: boolean
  floatingActions?: React.ReactNode
  children?: React.ReactNode
}

export function PageLayout({
  className,
  disableGuard = false,
  actions,
  floatingActions,
  children,
  ...props
}: PageLayoutProps) {
  const isSignedOut = useAtomValue(isSignedOutAtom)
  const isDatabaseMode = useAtomValue(isDatabaseModeAtom)
  const isRepoNotCloned = useAtomValue(isRepoNotClonedAtom)
  const isCloningRepo = useAtomValue(isCloningRepoAtom)
  const notesReady = useAtomValue(notesReadyAtom)
  const githubRepo = useAtomValue(githubRepoAtom)
  const databaseStatus = useAtomValue(databaseModeStatusAtom)

  // The repo screen is a git-mode concept: in database mode the machine parks
  // in `notCloned` (its repo flow is refused), notes are served from the
  // database, and post-auth routing goes straight to them.
  const showRepoForm = isRepoNotCloned && !isDatabaseMode && !disableGuard
  const showContent = notesReady || isSignedOut || disableGuard

  return (
    <HoverCard.Provider>
      <div className={cx("grid grid-rows-[auto_1fr] overflow-hidden", className)}>
        <PageHeader
          {...props}
          actions={showContent ? actions : undefined}
          className="print:hidden"
        />
        <div className="relative grid overflow-hidden">
          <main className="relative isolate overflow-auto [scrollbar-gutter:stable] scroll-mask">
            {showRepoForm ? (
              <div className="flex h-full flex-col items-center">
                <div className="mx-auto w-full max-w-lg p-4 pb-8 md:pb-14">
                  <div className="card-1 flex flex-col gap-6 p-4">
                    <div className="flex flex-col gap-2">
                      <h1 className="text-lg font-bold [text-box-trim:trim-start]">
                        Choose a repository
                      </h1>
                      <p className="text-pretty text-text-secondary">
                        Store your notes as markdown files in a GitHub repository of your choice.
                      </p>
                    </div>
                    <RepoForm />
                  </div>
                </div>
              </div>
            ) : null}
            {isCloningRepo && !isDatabaseMode && githubRepo && !disableGuard ? (
              <div className="flex items-center gap-2 p-4 leading-4 text-text-secondary">
                <LoadingIcon16 />
                Cloning {githubRepo.owner}/{githubRepo.name}…
              </div>
            ) : null}
            {isDatabaseMode && databaseStatus.emptyOffline && !disableGuard ? (
              <div className="p-4">
                <Notice tone="info">
                  No notes yet — this device hasn’t been able to reach the notes database. They’ll
                  load automatically once you’re back online, and anything you write now is kept
                  locally and synced later.
                </Notice>
              </div>
            ) : null}
            {showContent ? children : null}
          </main>

          <div className="absolute bottom-3 right-3 flex items-center gap-2 coarse:gap-3">
            {floatingActions}
          </div>
        </div>
      </div>
    </HoverCard.Provider>
  )
}
