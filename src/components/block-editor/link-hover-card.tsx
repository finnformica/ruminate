import { PreviewCard } from "@base-ui/react/preview-card"
import type React from "react"
import { useEffect, useState } from "react"
import { hostOf } from "../../blocks/link"
import { cx } from "../../utils/cx"
import { Button } from "../button"
import { ExternalLinkIcon16, GlobeIcon16 } from "../icons"

/** Opens `url` in a new tab, always, as a link with `target="_blank"` does. */
export function openLink(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer")
}

/**
 * The card that opens over a link (docs/links.md): where it goes and
 * **Visit**, a field for its display text, and — when the link has another
 * form to take (`toggle`) — the button that switches it. Only in an
 * editable editor; elsewhere a link is only a link. Hover or focus the
 * link to open it; the card is a popup of its own, so the page's
 * hover-card provider need not be around it.
 *
 * The display text is saved on Enter, or on leaving the field with it
 * changed; an emptied field saves nothing.
 *
 * A touch screen has nothing to hover with, so the row's context menu
 * offers **Edit link**, which opens the card outright (`open`); a tap
 * outside, or Escape, closes it and says so (`onClose`).
 */
export function LinkHoverCard({
  href,
  title,
  onRename,
  toggle,
  open: forced = false,
  onClose,
  render,
  children,
}: {
  href: string
  /** The link's current display text (a block's title). */
  title: string
  /** Save a new display text. */
  onRename: (next: string) => void
  /** Another form the link can take: its label and what makes the change. */
  toggle?: { label: string; onClick: () => void }
  /** Open the card now, without a hover (the menu's "Edit link"). */
  open?: boolean
  /** The card closed after being opened that way. */
  onClose?: () => void
  /** The element the card opens over. */
  render: React.ReactElement
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(forced)
  useEffect(() => {
    if (forced) setOpen(true)
  }, [forced])
  return (
    <PreviewCard.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next && forced) onClose?.()
      }}
    >
      <PreviewCard.Trigger render={render} delay={400} closeDelay={150}>
        {children}
      </PreviewCard.Trigger>
      <PreviewCard.Portal>
        <PreviewCard.Positioner side="bottom" sideOffset={6} align="start">
          <PreviewCard.Popup
            data-testid="link-hover-card"
            className={cx(
              "card-2 z-30 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-lg p-2 print:hidden",
              "origin-(--transform-origin) transition-[transform,scale,opacity]",
              "data-ending-style:scale-95 data-ending-style:opacity-0",
              "data-starting-style:scale-95 data-starting-style:opacity-0",
            )}
          >
            <div className="flex items-center gap-2 pl-1">
              <GlobeIcon16 className="shrink-0 text-text-tertiary" />
              <span className="min-w-0 flex-1 truncate text-sm text-text-secondary" title={href}>
                {hostOf(href)}
                <span className="text-text-tertiary">{pathOf(href)}</span>
              </span>
              <Button
                size="small"
                className="shrink-0 gap-1"
                onClick={(event) => {
                  event.stopPropagation()
                  openLink(href)
                }}
              >
                Visit
                <ExternalLinkIcon16 className="-mr-0.5 size-3.5" />
              </Button>
            </div>
            <DisplayText href={href} title={title} onRename={onRename} toggle={toggle} />
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  )
}

function DisplayText({
  href,
  title,
  onRename,
  toggle,
}: {
  href: string
  title: string
  onRename: (next: string) => void
  toggle?: { label: string; onClick: () => void }
}) {
  // A link whose text is its own address (a typed one, never rewritten)
  // is offered the host it would have been given on paste.
  const current = title.trim() === "" || title.trim() === href ? hostOf(href) : title
  const [value, setValue] = useState(current)
  const save = () => {
    const next = value.trim()
    if (next !== "" && next !== title) onRename(next)
  }
  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault()
        save()
      }}
    >
      <input
        aria-label="Display text"
        data-testid="link-display-text"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={save}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        className="focus-ring h-7 min-w-0 flex-1 rounded border border-border-secondary bg-transparent px-2 text-sm text-text placeholder:text-text-tertiary"
        placeholder="Display text"
      />
      {toggle ? (
        <Button
          size="small"
          type="button"
          className="shrink-0"
          onClick={(event) => {
            event.stopPropagation()
            toggle.onClick()
          }}
        >
          {toggle.label}
        </Button>
      ) : null}
    </form>
  )
}

/** The address after its host, `/` alone dropped. */
function pathOf(href: string): string {
  try {
    const url = new URL(href)
    const rest = url.pathname + url.search + url.hash
    return rest === "/" ? "" : rest
  } catch {
    return ""
  }
}
