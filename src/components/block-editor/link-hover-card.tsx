import { PreviewCard } from "@base-ui/react/preview-card"
import copy from "copy-to-clipboard"
import type React from "react"
import { useEffect, useState } from "react"
import { hostOf } from "../../blocks/link"
import { cx } from "../../utils/cx"
import { Button } from "../button"
import { IconButton } from "../icon-button"
import { CopyIcon16, GlobeIcon16, TrashIcon16 } from "../icons"

/** What the card can do to the link it is over. */
export interface LinkCardActions {
  /** Save a new display text (a block's title). */
  rename: (next: string) => void
  /** Point the link at a new address. */
  retarget: (nextHref: string) => void
  /** Take the link off: the text stays, as words. */
  remove: () => void
  /** Another form the link can take: its label and what makes the change. */
  toggle?: { label: string; onClick: () => void }
}

/**
 * The card that opens over a link (docs/links.md), in Notion's shape. At
 * first a pill: where the link goes — the address, itself a link that
 * opens the page in a new tab — a button that copies it, and **Edit**.
 * Edit opens the panel: the address and the link's title, each a field,
 * and **Remove link**, with any other form the link can take
 * (**Turn into block**, **Turn into inline**) beside it. A field saves on
 * <kbd>↵</kbd>, or on leaving it with its value changed; an emptied field
 * saves nothing. Only in an editable editor; elsewhere a link is only a
 * link. Hover or focus the link to open it; the card is a popup of its
 * own, so the page's hover-card provider need not be around it.
 *
 * A touch screen has nothing to hover with, so the row's context menu
 * offers **Edit link**, which opens the card outright (`open`) at its
 * panel; a tap outside, or Escape, closes it and says so (`onClose`).
 */
export function LinkHoverCard({
  href,
  title,
  actions,
  open: forced = false,
  onClose,
  render,
  children,
}: {
  href: string
  /** The link's current display text (a block's title). */
  title: string
  actions: LinkCardActions
  /** Open the card now, without a hover, at its panel (the menu's "Edit link"). */
  open?: boolean
  /** The card closed after being opened that way. */
  onClose?: () => void
  /** The element the card opens over: the anchor, or the block's card. */
  render: React.ReactElement
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(forced)
  const [editing, setEditing] = useState(forced)
  useEffect(() => {
    if (forced) {
      setOpen(true)
      setEditing(true)
    }
  }, [forced])
  return (
    <PreviewCard.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setEditing(false)
          if (forced) onClose?.()
        }
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
              "card-2 z-30 rounded-lg print:hidden",
              "origin-(--transform-origin) transition-[transform,scale,opacity]",
              "data-ending-style:scale-95 data-ending-style:opacity-0",
              "data-starting-style:scale-95 data-starting-style:opacity-0",
            )}
          >
            {editing ? (
              <EditPanel href={href} title={title} actions={actions} />
            ) : (
              <Pill href={href} onEdit={() => setEditing(true)} />
            )}
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  )
}

/** The card at rest: the address, a copy of it, and the way to the panel. */
function Pill({ href, onEdit }: { href: string; onEdit: () => void }) {
  return (
    <div className="flex max-w-[calc(100vw-2rem)] items-center gap-1 p-1 pl-2.5">
      <GlobeIcon16 className="shrink-0 text-text-tertiary" />
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        data-testid="link-card-address"
        onClick={(event) => event.stopPropagation()}
        className="focus-ring min-w-0 max-w-72 truncate rounded-sm px-1 text-sm text-text-secondary hover:text-text"
      >
        {href}
      </a>
      <IconButton
        size="small"
        aria-label="Copy address"
        tooltipSide="top"
        onClick={(event) => {
          event.stopPropagation()
          copy(href)
        }}
      >
        <CopyIcon16 />
      </IconButton>
      <Button
        size="small"
        data-testid="link-card-edit"
        onClick={(event) => {
          event.stopPropagation()
          onEdit()
        }}
      >
        Edit
      </Button>
    </div>
  )
}

/** The card opened up: the address and the title, each a field, and what
 * else can be done with the link. */
function EditPanel({
  href,
  title,
  actions,
}: {
  href: string
  title: string
  actions: LinkCardActions
}) {
  const [address, setAddress] = useState(href)
  // A link whose text is its own address (a typed one, never rewritten)
  // is offered the host it would have been given on paste.
  const current = title.trim() === "" || title.trim() === href ? hostOf(href) : title
  const [text, setText] = useState(current)
  const saveAddress = () => {
    const next = address.trim()
    if (next !== "" && next !== href) actions.retarget(next)
  }
  const saveTitle = () => {
    const next = text.trim()
    if (next !== "" && next !== title) actions.rename(next)
  }
  const stop = (event: React.SyntheticEvent) => event.stopPropagation()
  return (
    <form
      data-testid="link-card-panel"
      className="flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-3 p-3"
      onSubmit={(event) => {
        event.preventDefault()
        saveAddress()
        saveTitle()
      }}
      onClick={stop}
      onKeyDown={stop}
    >
      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-text-secondary">URL</span>
        <input
          data-testid="link-card-url"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          onBlur={saveAddress}
          spellCheck={false}
          placeholder="https://"
          className={FIELD}
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-text-secondary">Link title</span>
        <input
          data-testid="link-display-text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onBlur={saveTitle}
          placeholder="Display text"
          autoFocus
          className={FIELD}
        />
      </label>
      <div className="-mx-1 -mb-1 flex items-center justify-between border-t border-border-secondary pt-2">
        <button
          type="button"
          data-testid="link-card-remove"
          onClick={() => actions.remove()}
          className="focus-ring flex h-7 items-center gap-2 rounded px-2 text-sm text-text-secondary hover:bg-bg-hover hover:text-text"
        >
          <TrashIcon16 />
          Remove link
        </button>
        {actions.toggle ? (
          <Button size="small" type="button" onClick={actions.toggle.onClick}>
            {actions.toggle.label}
          </Button>
        ) : null}
      </div>
    </form>
  )
}

const FIELD =
  "focus-ring h-8 min-w-0 rounded border border-border-secondary bg-transparent px-2 text-sm text-text placeholder:text-text-tertiary"
