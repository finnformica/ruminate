import { ContextMenu } from "@base-ui/react/context-menu"
import { Menu } from "@base-ui/react/menu"
import React from "react"
import { FIGURE_ALIGNS, type FigureAlign } from "../../blocks/figure"
import type { BlockType } from "../../blocks/types"
import { cx } from "../../utils/cx"
import type { BlockActions } from "./block-actions"
import { DropdownMenu } from "../ui/dropdown-menu"
import { Sheet } from "../ui/sheet"
import { Surface } from "../ui/surface"

/**
 * The block's right-click menu: the standard actions on one row, the same
 * commands the keyboard runs, so nothing here has a second meaning. Opened
 * by the editor on any row it owns (never in read-only views); the editor
 * supplies the row (`target`) and the actions, this file the menu. The
 * actions on blocks are the editor's one set (`block-actions.ts`), the same
 * object the selection bar runs, each over the rows the menu is for
 * (`target.keys`): the row alone, or the selected range it is in — in which
 * case the item says how many blocks it takes.
 *
 * Removing is graph-aware. A row is one place a block appears. In a note's
 * outline the menu offers **Unlink** (what ⌫ does: the row goes, the block
 * stays — held wherever else it is, or in the note's Unassigned basket) and
 * **Delete**, which removes the block itself from every place it appears
 * (`deleteBlockOps`), with the place count beside it when there is more
 * than one. Where a row's removal is the delete — the basket, and editors
 * with no graph behind them — there is only **Delete** (⌫); the basket adds
 * **Delete with contents** on a block that holds something, since
 * its plain Delete leaves what the block held as new basket roots.
 *
 * **Pin** puts the block in the sidebar's Views list (docs/metadata.md),
 * from where it opens focused on; on a pinned block the item reads Unpin.
 *
 * The menu carries only what nothing else on the row does. Editing is a
 * click or a tap; collapsing is the chevron; indent, outdent, focus and the
 * block types are keys on a desktop and the edit bar's buttons on a phone
 * (`mobile-edit-bar.tsx`). What is left — the moves, duplicate, copy, the
 * links and figures' own actions, pin, share, delete — is one list on two
 * surfaces, the popup and the sheet, with keys beside it on the popup. It
 * runs in sections, ruled apart: copying first, then the row's own link or
 * figure actions, arranging (move, duplicate), pin and share, and removing
 * last.
 */

/** The row the menu was opened on. */
export interface BlockMenuTarget {
  key: string
  id: string
  type: BlockType
  hasChildren: boolean
  /** The rows the block actions act on: the selected range's roots when
   * the row is one of them, else the row alone — a list of one. */
  keys: string[]
  /** How many places the block appears across the corpus (1 = only here). */
  places: number
  /** Pinned (docs/metadata.md): listed in the sidebar's Views list. */
  pinned: boolean
  /** A figure row's layout (`src/blocks/figure.ts`): the side its picture
   * or card keeps to, and whether it has been dragged to a size of its own. */
  figure?: { align: FigureAlign; sized: boolean }
  /** The web links in the row's text (docs/links.md), for "Edit link" and
   * "Turn into link block"; a link block's own address. */
  links?: { href: string; title: string }[]
}

/** The editor's block actions, plus what only a menu on one row offers:
 * the block's own link, picture, card, pin and share. */
export interface BlockMenuActions extends BlockActions {
  /** Absent when the editor has no note to link into (Storybook, tests). */
  copyLink?: (id: string) => void
  /** Pin this block — or unpin it, when it is (`target.pinned`): a pinned
   * block is listed in the sidebar under Pinned and opens focused on.
   * Absent where the rows are not the user's own to pin. */
  pin?: (id: string) => void
  /** Share this block — and everything beneath it — with someone
   * (docs/sharing.md). Absent where the rows are not the user's own. */
  share?: (id: string) => void
  /** Open a link's card (`link-hover-card.tsx`) outright — a touch screen
   * has nothing to hover with. */
  editLink?: (key: string, href: string) => void
  /** Make a link block of the row's first link (docs/links.md): "Turn
   * into link block", what the hover card's "Turn into block" does. */
  turnIntoLink?: (key: string, href: string, title: string) => void
  /** Image rows: expand the picture, and save it to the device. */
  openImage?: (id: string) => void
  downloadImage?: (id: string) => void
  /** Link rows (docs/links.md): open the page in a new tab, and fetch its
   * preview again (absent signed out, where there is nothing to fetch it
   * through). */
  openLink?: (id: string) => void
  refreshPreview?: (id: string) => void
  /** Link rows: back to a paragraph holding the link as text (the hover
   * card offers the same; here for a keyboard or a touch screen). */
  linkToInline?: (id: string) => void
  /** Figure rows: which side of the row the picture or card keeps to. */
  alignFigure?: (id: string, align: FigureAlign) => void
  /** Figure rows: return a dragged figure to its natural width. */
  resetFigureSize?: (id: string) => void
}

/** The Align submenu's items, in the order the figure's toolbar has them. */
const ALIGN_LABELS: Record<FigureAlign, string> = {
  left: "Left",
  center: "Centre",
  right: "Right",
}

/** The menu and its submenus are drawn on the same surface as every other
 * menu in the app (src/components/ui/surface.tsx). */
const popup = (
  <Surface className="grid place-items-stretch overflow-hidden print:hidden outline-hidden" />
)

export function BlockContextMenu({
  target,
  actions,
  onOpenChange,
  children,
}: {
  target: BlockMenuTarget | null
  actions: BlockMenuActions
  /** Open or closed, and the event that did it (a `contextmenu` for a
   * right-click; the `touchstart` of a press-and-hold, Base UI's own 500ms
   * one, which never yields a `contextmenu` on a phone). The editor reads
   * the row from its target, and whether a finger is still down. */
  onOpenChange?: (open: boolean, event: Event | undefined) => void
  children: React.ReactNode
}) {
  return (
    <ContextMenu.Root onOpenChange={(open, details) => onOpenChange?.(open, details.event)}>
      <ContextMenu.Trigger>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-popup outline-none">
          <ContextMenu.Popup data-testid="block-context-menu" render={popup} style={{ width: 240 }}>
            {/* A pointer's menu keeps to a modest height; a phone's, with 40px
                rows, would otherwise hide the last items (Unlink, Delete) in a
                scroll no one finds — it may take most of the screen instead. */}
            <div className="grid max-h-[45svh] scroll-py-1 overflow-auto p-1 coarse:max-h-[80svh]">
              {target ? <Items target={target} actions={actions} /> : null}
            </div>
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}

/**
 * What the menu holds for a row, as data: one list for both renderers — the
 * pointer's popup (`Items`) and the touch screen's sheet (`BlockMenuSheet`).
 * Each entry is an action, a rule between groups, or a group of choices
 * (the popup's submenu; the sheet's inline group).
 */
export type MenuEntry =
  | {
      kind: "item"
      label: string
      onSelect: () => void
      shortcut?: string[]
      danger?: boolean
      selected?: boolean
      trailing?: React.ReactNode
    }
  | { kind: "separator" }
  | {
      kind: "group"
      label: string
      testId?: string
      width?: number
      items: { label: React.ReactNode; onSelect: () => void; selected?: boolean; key: string }[]
    }

function menuEntries(target: BlockMenuTarget, actions: BlockMenuActions): MenuEntry[] {
  const { key, id, keys } = target
  // A range's actions say how many blocks they take: "Delete 3 blocks".
  const many = keys.length > 1 ? ` ${keys.length} blocks` : ""
  const shared = target.places > 1 && keys.length === 1
  const image = target.type === "image"
  const link = target.type === "link"
  const figure = target.figure !== undefined
  const links = target.links ?? []
  const entries: MenuEntry[] = []
  // The menu is sections, a rule between each two that have something in
  // them: a section a row has nothing for (a plain paragraph has no link or
  // figure actions, a view no Pin) leaves no doubled or dangling rule.
  let ruleDue = false
  const section = () => {
    ruleDue = entries.length > 0
  }
  const push = (entry: MenuEntry) => {
    if (ruleDue) entries.push({ kind: "separator" })
    ruleDue = false
    entries.push(entry)
  }
  const item = (e: Omit<Extract<MenuEntry, { kind: "item" }>, "kind">) =>
    push({ kind: "item", ...e })

  // Copying, first: what a hold is most often for.
  item({ label: `Copy${many}`, shortcut: ["⌘", "C"], onSelect: () => actions.copy(keys) })
  if (actions.copyLink)
    item({ label: "Copy link to block", onSelect: () => actions.copyLink?.(id) })

  // The row's own kind of thing: its links, its picture, its card.
  section()
  // A link's card, for a screen with nothing to hover with: the one link
  // straight away, several by their display text.
  if (links.length === 1 && actions.editLink) {
    item({ label: "Edit link", onSelect: () => actions.editLink?.(key, links[0].href) })
  } else if (links.length > 1 && actions.editLink) {
    push({
      kind: "group",
      label: "Edit link",
      testId: "edit-link-menu",
      width: 200,
      items: links.map((l, index) => ({
        key: `${index}:${l.href}`,
        label: <span className="truncate">{l.title}</span>,
        onSelect: () => actions.editLink?.(key, l.href),
      })),
    })
  }
  if (image && actions.openImage)
    item({ label: "Open image", onSelect: () => actions.openImage?.(id) })
  if (image && actions.downloadImage)
    item({ label: "Download image", onSelect: () => actions.downloadImage?.(id) })
  if (link && actions.openLink) item({ label: "Open link", onSelect: () => actions.openLink?.(id) })
  if (link && actions.refreshPreview)
    item({ label: "Refresh preview", onSelect: () => actions.refreshPreview?.(id) })
  // A figure's layout: the side it keeps to (the frame's own toolbar offers
  // the same), and its natural width back after a drag.
  if (figure && actions.alignFigure) {
    push({
      kind: "group",
      label: "Align",
      testId: "figure-align-menu",
      width: 160,
      items: FIGURE_ALIGNS.map((align) => ({
        key: align,
        label: ALIGN_LABELS[align],
        selected: target.figure?.align === align,
        onSelect: () => actions.alignFigure?.(id, align),
      })),
    })
  }
  if (figure && target.figure?.sized && actions.resetFigureSize) {
    item({
      label: image ? "Original size" : "Full width",
      onSelect: () => actions.resetFigureSize?.(id),
    })
  }
  // A link block goes back to the inline link it was made from; a row with
  // a link in its text makes a link block of the first one, in place or
  // beneath (docs/links.md). A figure is its picture or its page, so it is
  // never turned into anything else.
  if (link && actions.linkToInline)
    item({ label: "Turn into inline", onSelect: () => actions.linkToInline?.(id) })
  if (!figure && links.length > 0 && actions.turnIntoLink) {
    item({
      label: "Turn into link block",
      onSelect: () => actions.turnIntoLink?.(key, links[0].href, links[0].title),
    })
  }

  // Arranging: where the block sits, and a second of it.
  section()
  item({ label: "Move up", shortcut: ["⌥", "↑"], onSelect: () => actions.moveUp(keys) })
  item({ label: "Move down", shortcut: ["⌥", "↓"], onSelect: () => actions.moveDown(keys) })
  item({
    label: `Duplicate${many}`,
    shortcut: ["⌥", "⇧", "↓"],
    onSelect: () => actions.duplicate(keys),
  })

  // Beyond the note: the sidebar, and other people.
  section()
  if (actions.pin)
    item({ label: target.pinned ? "Unpin" : "Pin", onSelect: () => actions.pin?.(id) })
  if (actions.share) item({ label: "Share…", onSelect: () => actions.share?.(id) })

  // Removing, last and apart.
  section()
  if (actions.deleteEverywhere) {
    item({ label: `Unlink${many}`, shortcut: ["⌫"], onSelect: () => actions.remove(keys) })
    item({
      label: `Delete${many}`,
      danger: true,
      trailing: shared ? (
        <span className="text-sm text-text-secondary">{target.places} places</span>
      ) : undefined,
      onSelect: () => actions.deleteEverywhere?.(keys),
    })
  } else {
    item({
      label: `Delete${many}`,
      danger: true,
      shortcut: ["⌫"],
      onSelect: () => actions.remove(keys),
    })
    if (actions.deleteSubtree && target.hasChildren) {
      item({
        label: `Delete${many} with contents`,
        danger: true,
        onSelect: () => actions.deleteSubtree?.(keys),
      })
    }
  }
  return entries
}

/** The pointer's popup: the entries as Base UI menu items and submenus. */
function Items({ target, actions }: { target: BlockMenuTarget; actions: BlockMenuActions }) {
  const entries = menuEntries(target, actions)
  return (
    <>
      {entries.map((entry, index) => {
        if (entry.kind === "separator") return <DropdownMenu.Separator key={index} />
        if (entry.kind === "group") {
          return (
            <Menu.SubmenuRoot key={index}>
              <DropdownMenu.SubmenuTrigger>{entry.label}</DropdownMenu.SubmenuTrigger>
              <Menu.Portal>
                <Menu.Positioner className="z-popup" side="right" align="start" sideOffset={4}>
                  <Menu.Popup render={popup} style={{ width: entry.width ?? 200 }}>
                    <div className="grid p-1" data-testid={entry.testId}>
                      {entry.items.map((it) => (
                        <DropdownMenu.Item
                          key={it.key}
                          selected={it.selected}
                          onClick={it.onSelect}
                        >
                          {it.label}
                        </DropdownMenu.Item>
                      ))}
                    </div>
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.SubmenuRoot>
          )
        }
        return (
          <DropdownMenu.Item
            key={index}
            shortcut={entry.shortcut}
            variant={entry.danger ? "danger" : undefined}
            trailingVisual={entry.trailing}
            onClick={entry.onSelect}
          >
            {entry.label}
          </DropdownMenu.Item>
        )
      })}
    </>
  )
}

/**
 * The touch screen's block menu: a sheet that rises from the bottom
 * (docs/mobile.md), opened by the editor on a press-and-hold, where a popup
 * anchored under a finger opened and shut again as the finger lifted. The
 * same entries, laid out for a thumb: 44px rows, groups inline under a
 * small heading with the current choice marked, the row's text at the top
 * so it is clear which block the sheet is for. A pick closes the sheet;
 * so does a swipe down or a tap on the page.
 *
 * The sheet rises while the finger that held the row is still down, so its
 * rows take no pick until that finger has lifted (`holding`): the lift, and
 * the click the browser owes it, land on whatever row is under the finger
 * by then, and are not a choice.
 */
export function BlockMenuSheet({
  target,
  title,
  actions,
  holding = false,
  open,
  onOpenChange,
}: {
  target: BlockMenuTarget | null
  /** The block's text, for the sheet's heading. */
  title: string
  actions: BlockMenuActions
  /** The finger that opened the sheet is still down (or only just up). */
  holding?: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const entries = target ? menuEntries(target, actions) : []
  const pick = (run: () => void) => () => {
    if (holding) return
    onOpenChange(false)
    run()
  }
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <Sheet.Content
        data-testid="block-menu-sheet"
        className="select-none [-webkit-touch-callout:none]"
        size="fit"
        handle
        titleVisible
        title={title.trim() || "Block"}
      >
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {entries.map((entry, index) => {
            if (entry.kind === "separator") {
              return <div key={index} className="mx-3 my-1 h-px bg-border-secondary" />
            }
            if (entry.kind === "group") {
              // A group's choices as chips in a row, the current one
              // filled: seven block types read at a glance, where seven
              // rows would push the rest of the sheet off the screen.
              return (
                <div key={index} className="py-1" data-testid={entry.testId}>
                  <div className="px-3 pt-2 pb-1.5 text-xs font-medium text-text-tertiary">
                    {entry.label}
                  </div>
                  <div className="flex flex-wrap gap-2 px-3 pb-1">
                    {entry.items.map((it) => (
                      <button
                        key={it.key}
                        type="button"
                        aria-pressed={it.selected}
                        onClick={pick(it.onSelect)}
                        className={cx(
                          "h-9 max-w-full cursor-pointer select-none truncate rounded-full px-3 text-[14px] ring-1 ring-inset active:bg-bg-active",
                          it.selected
                            ? "bg-bg-secondary text-text ring-transparent"
                            : "text-text-secondary ring-border-secondary",
                        )}
                      >
                        {it.label}
                      </button>
                    ))}
                  </div>
                </div>
              )
            }
            return (
              <SheetRow
                key={index}
                danger={entry.danger}
                onSelect={pick(entry.onSelect)}
                trailing={entry.trailing}
              >
                {entry.label}
              </SheetRow>
            )
          })}
        </div>
      </Sheet.Content>
    </Sheet>
  )
}

function SheetRow({
  children,
  onSelect,
  danger,
  trailing,
}: {
  children: React.ReactNode
  onSelect: () => void
  danger?: boolean
  trailing?: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cx(
        "flex h-11 w-full cursor-pointer select-none items-center gap-3 rounded px-3 text-left text-[15px] active:bg-bg-active",
        danger ? "text-text-danger" : "text-text",
      )}
    >
      <span className="min-w-0 grow truncate">{children}</span>
      {trailing}
    </button>
  )
}
