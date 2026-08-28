import React from "react"
import { cx } from "../utils/cx"
import { Button } from "./button"
import { ErrorIcon16 } from "./icons"

type NoticeTone = "info" | "warning"

/**
 * The app's one notice surface — see "Notices" in docs/design-principles.md.
 * Every non-blocking "something needs your attention" message (storage quota,
 * merge notices, the remote-edit notice on a note) renders through this so
 * they read as one family: base-radius surface, subtle border, an icon slot
 * on the left, the message in the middle, actions (and an optional Dismiss)
 * on the right.
 *
 * Tones color the icon rank, not the prose: `info` keeps a tertiary icon,
 * `warning` uses the pending yellow. Placement is the caller's: app-scope
 * notices sit in a full-width strip above the layout, page-scope notices sit
 * inline above the content they concern.
 */
export const Notice = React.forwardRef<
  HTMLDivElement,
  {
    tone?: NoticeTone
    /** Replaces the tone's default icon (pass `null` to omit it). */
    icon?: React.ReactNode
    /** Action buttons, rendered before the Dismiss affordance. */
    actions?: React.ReactNode
    /** Renders the standard Dismiss button wired to this handler. */
    onDismiss?: () => void
    className?: string
    children: React.ReactNode
  }
>(function Notice({ tone = "info", icon, actions, onDismiss, className, children }, ref) {
  const resolvedIcon = icon === undefined ? <ErrorIcon16 /> : icon
  return (
    <div
      ref={ref}
      role="status"
      data-tone={tone}
      className={cx(
        "flex flex-wrap items-start justify-between gap-x-3 gap-y-2 rounded border border-border-secondary bg-bg-card p-2 pl-3",
        className,
      )}
    >
      <span className="flex min-w-0 grow items-start gap-2">
        {resolvedIcon !== null ? (
          <span
            className={cx(
              "grid h-6 shrink-0 place-items-center",
              tone === "warning" ? "text-text-pending" : "text-text-tertiary",
            )}
          >
            {resolvedIcon}
          </span>
        ) : null}
        <span className="min-w-0 grow pt-0.5 leading-5">{children}</span>
      </span>
      {actions || onDismiss ? (
        <span className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
          {onDismiss ? (
            <Button size="small" onClick={onDismiss}>
              Dismiss
            </Button>
          ) : null}
        </span>
      ) : null}
    </div>
  )
})
