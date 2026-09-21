import { PreviewCard } from "@base-ui/react/preview-card"
import copy from "copy-to-clipboard"
import type React from "react"
import { useEffect, useRef, useState } from "react"
import { hostOf } from "../../blocks/link"
import { Surface } from "../ui/surface"
import { Button } from "../ui/button"
import { IconButton } from "../ui/icon-button"
import { CopyIcon16, GlobeIcon16, TrashIcon16 } from "../icons"

/** What the card can do to the link it is over. */
export interface LinkCardActions {
  /** Save a new display text (a block's title) and/or address, in one go. */
  update: (next: { href?: string; title?: string }) => void
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
 * <kbd>↵</kbd>, on leaving it for the other, and — whatever is still
 * unsaved — when the card closes, however it closes: a click elsewhere
 * takes the popup down on pointer-down, before the field's blur can fire,
 * so the card flushes its fields itself on the way out. An emptied field
 * saves nothing. Only in an editable editor; elsewhere a link is only a
 * link. Hover or focus the link to open it; the card is a popup of its
 * own, so the page's hover-card provider need not be around it.
 *
 * A touch screen has nothing to hover with, so the row's context menu
 * offers **Edit link**, which opens the card outright (`open`) at its
 * panel; a tap outside, or Escape, closes it and says so (`onClose`).
 *
 * The panel is a raised surface, and hover is not its business: it stays
 * open while the pointer wanders (off the link, over the row below), and
 * closes only on a press outside, Escape, or the reader's own action — as
 * a menu or a dialog would, which Base UI makes modal for the same reason.
 * And while any card's panel is open, no other card opens on hover, so a
 * link block beneath cannot steal the pointer and take the panel down.
 */

/** How many cards are at their panel, across the page. */
let panelsOpen = 0

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
  // What the panel has not saved yet, to save as the card closes.
  const flush = useRef<(() => void) | null>(null)
  useEffect(() => {
    if (forced) {
      setOpen(true)
      setEditing(true)
    }
  }, [forced])
  useEffect(() => {
    if (!editing) return
    panelsOpen += 1
    return () => {
      panelsOpen -= 1
    }
  }, [editing])
  return (
    <PreviewCard.Root
      open={open}
      onOpenChange={(next, details) => {
        const hover = details.reason === "trigger-hover"
        // A pointer cannot open a card over another's panel, nor close a
        // panel by leaving it.
        if (hover && ((next && panelsOpen > 0 && !editing) || (!next && editing))) return
        if (!next) flush.current?.()
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
        <PreviewCard.Positioner className="z-popup" side="bottom" sideOffset={6} align="start">
          <PreviewCard.Popup
            data-testid="link-hover-card"
            render={<Surface className="print:hidden" />}
          >
            {editing ? (
              <EditPanel href={href} title={title} actions={actions} flush={flush} />
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
  flush,
}: {
  href: string
  title: string
  actions: LinkCardActions
  /** Where the panel leaves what it has not saved, for the card to save
   * as it closes. */
  flush: React.MutableRefObject<(() => void) | null>
}) {
  const [address, setAddress] = useState(href)
  // A link whose text is its own address (a typed one, never rewritten)
  // is offered the host it would have been given on paste.
  const offered = title.trim() === "" || title.trim() === href ? hostOf(href) : title
  const [text, setText] = useState(offered)
  // The link changed under the panel — an undo, say — and the fields
  // follow it, so a close never writes back what was undone. After the
  // panel's own save the props catch up with the fields; the same values.
  useEffect(() => setAddress(href), [href])
  useEffect(() => setText(offered), [offered])
  /**
   * Save what changed, both fields in one rewrite (two would race: the
   * second's search for the link would miss what the first had just
   * rewritten). A field left as it was opened is not a change — except on
   * <kbd>↵</kbd> (`submit`), which takes the offered host for a link that
   * had only its address for a title. An emptied field saves nothing.
   */
  const save = (submit = false) => {
    const nextHref = address.trim()
    const nextTitle = text.trim()
    const next: { href?: string; title?: string } = {}
    if (nextHref !== "" && nextHref !== href) next.href = nextHref
    if (nextTitle !== "" && nextTitle !== (submit ? title : offered)) next.title = nextTitle
    if (next.href !== undefined || next.title !== undefined) actions.update(next)
  }
  // The latest values, saved by the card on close (a stale closure would
  // save what the fields held a render ago).
  useEffect(() => {
    flush.current = () => save()
    return () => {
      flush.current = null
    }
  })
  // The title is what the panel is most often opened to change (Notion
  // focuses it too); the field takes focus as the panel opens.
  const titleRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    titleRef.current?.focus()
  }, [])
  // Keystrokes and clicks in the fields are the panel's, never the row's:
  // the popup is portalled, but React events still bubble to the row, whose
  // keymap would read an arrow or Escape and whose click would select it.
  const stop = (event: React.SyntheticEvent) => event.stopPropagation()
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <form
      data-testid="link-card-panel"
      className="flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-3 p-3"
      onSubmit={(event) => {
        event.preventDefault()
        save(true)
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
          onBlur={() => save()}
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
          onBlur={() => save()}
          placeholder="Display text"
          ref={titleRef}
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
