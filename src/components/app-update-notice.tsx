import { useAtomValue } from "jotai"
import { useState } from "react"
import { requestDatabaseFlush } from "../data/database-mode"
import { appUpdateAtom } from "../hooks/app-update"
import { cx } from "../utils/cx"
import { Notice } from "./notice"
import { AsyncButton } from "./ui/async-button"

/**
 * The phone's word that a newer build is waiting: an app-scope notice in a
 * strip above the page (docs/design-principles.md, "Notices"), with
 * **Update** beside it.
 *
 * On a wide screen the sidebar's "Update Ruminate" row is always in view. On
 * a phone that row is at the foot of the navigation drawer, below the Views
 * list, and the only sign of it outside the drawer is a dot on the menu
 * button — a dot that sync trouble takes over. So the phone says it here,
 * where nothing has to be opened or scrolled to. The strip is phone-only: the
 * caller hides it from the `sm` breakpoint, where the sidebar's row stands.
 *
 * Dismiss puts it away for this launch; the dot and the drawer's row stay,
 * and it returns with the next launch while the update is still waiting.
 * Update lands the pending edits first, as the keyboard's ⌘⇧U does, since
 * applying ends in a reload.
 */
export function AppUpdateNotice({ className }: { className?: string }) {
  const { needRefresh, apply } = useAtomValue(appUpdateAtom)
  const [dismissed, setDismissed] = useState(false)
  if (!needRefresh || dismissed) return null
  return (
    <div className={cx("border-b border-border-secondary p-2 print:hidden", className)}>
      <Notice
        icon={<UpdateDot />}
        actions={
          <AsyncButton onClick={() => requestDatabaseFlush().then(apply)}>Update</AsyncButton>
        }
        onDismiss={() => setDismissed(true)}
      >
        A new version of Ruminate is ready.
      </Notice>
    </div>
  )
}

/** The waiting-update dot, as the sidebar's row and the menu button wear it. */
function UpdateDot() {
  return (
    <div
      aria-hidden
      className="grid size-4 place-items-center [&>*]:row-span-full [&>*]:col-span-full"
    >
      <div className="size-3 rounded-full bg-border-focus opacity-50 animate-ping" />
      <div className="size-2 rounded-full bg-border-focus" />
    </div>
  )
}
