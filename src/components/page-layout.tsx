import { useAtomValue } from "jotai"
import { databaseModeStatusAtom } from "../data/database-mode"
import { storageDiagnosticsAtom } from "../data/storage-diagnostics"
import { isDatabaseModeAtom, isSignedOutAtom } from "../global-state"
import { cx } from "../utils/cx"
import { Button } from "./button"
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
  const databaseStatus = useAtomValue(databaseModeStatusAtom)
  const diagnostics = useAtomValue(storageDiagnosticsAtom)
  // A second Ruminate tab holds the persistent local database — this tab fell
  // back to a temporary in-memory copy and must say so (defect: it used to
  // silently show an empty corpus).
  const otherTabHasDatabase =
    diagnostics.persistence === "memory" && diagnostics.persistenceReason === "another-tab"

  // Signed in, the store serves notes immediately (isDatabaseMode); signed out,
  // the sample notes render. The only gated moment is the brief auth
  // resolution at boot.
  const showContent = isDatabaseMode || isSignedOut || disableGuard

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
            {otherTabHasDatabase && !disableGuard ? (
              <div className="p-4">
                <Notice
                  tone="warning"
                  actions={<Button onClick={() => window.location.reload()}>Reload</Button>}
                >
                  Ruminate is open in another tab — this tab is using a temporary in-memory copy.
                  Close the other tab and reload to work here.
                </Notice>
              </div>
            ) : null}
            {databaseStatus.emptyOffline && !disableGuard ? (
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
