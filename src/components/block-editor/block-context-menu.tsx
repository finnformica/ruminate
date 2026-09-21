import { ContextMenu } from "@base-ui/react/context-menu"
import { Menu } from "@base-ui/react/menu"
import React from "react"
import { Drawer } from "vaul"
import { FIGURE_ALIGNS, type FigureAlign } from "../../blocks/figure"
import { BLOCK_TYPE_DEFS, canonicalOf } from "../../blocks/registry"
import type { BlockType } from "../../blocks/types"
import { cx } from "../../utils/cx"
import { DropdownMenu } from "../dropdown-menu"

/**
 * The block's right-click menu: the standard actions on one row, the same
 * commands the keyboard runs, so nothing here has a second meaning. Opened
 * by the editor on any row it owns (never in read-only views); the editor
 * supplies the row (`target`) and the actions, this file the menu.
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
 * The structure moves (indent, outdent, move up/down) are in the menu with
 * their keys beside them. A mouse could leave them to the keyboard, but a
 * finger cannot (no Tab on a phone's keyboard), and the popup and the sheet
 * are one list on two surfaces — so every surface carries every action.
 */

/** The row the menu was opened on. */
export interface BlockMenuTarget {
  key: string
  id: string
  type: BlockType
  hasChildren: boolean
  collapsed: boolean
  /** How many places the block appears across the corpus (1 = only here). */
  places: number
  /** Pinned (docs/metadata.md): listed in the sidebar's Views list. */
  pinned: boolean
  /** A figure row's layout (`src/blocks/figure.ts`): the side its picture
   * or card keeps to, and whether it has been dragged to a size of its own. */
  figure?: { align: FigureAlign; sized: boolean }
  /** The web links in the row's text (docs/links.md), for "Edit link" and
   * "Turn into → Link"; a link block's own address. */
  links?: { href: string; title: string }[]
}

export interface BlockMenuActions {
  edit: (key: string) => void
  setType: (id: string, type: BlockType) => void
  duplicate: (key: string) => void
  /** Structure moves — offered on a touch screen only, where there are no
   * keys for them. */
  indent: (key: string) => void
  outdent: (key: string) => void
  moveUp: (key: string) => void
  moveDown: (key: string) => void
  toggleCollapse: (key: string) => void
  focusBlock: (id: string) => void
  copy: (key: string) => void
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
   * into → Link", what the hover card's "Turn into block" does. */
  turnIntoLink?: (key: string, href: string, title: string) => void
  /** Remove this row (the block stays where else it is held). */
  remove: (key: string) => void
  /** Delete the block from every place it appears. Absent standalone. */
  deleteEverywhere?: (id: string) => void
  /** Delete the block and everything beneath it that nothing else holds
   * (the basket's). Absent where a delete never cascades. */
  deleteSubtree?: (id: string) => void
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

/** A submenu trigger row: the same shape as an item, with a chevron. */
function SubmenuTrigger({ children }: { children: React.ReactNode }) {
  return (
    <Menu.SubmenuTrigger className="group flex h-8 cursor-pointer select-none items-center gap-3 rounded px-3 outline-hidden focus:bg-bg-hover data-[popup-open]:bg-bg-hover coarse:h-10">
      <div className="flex w-0 grow items-center gap-3">
        <span className="grow truncate">{children}</span>
      </div>
      <span aria-hidden className="text-text-tertiary">
        ›
      </span>
    </Menu.SubmenuTrigger>
  )
}

/** The types a block can be turned into: the registry's, in its order. */
const TYPES = BLOCK_TYPE_DEFS.filter((def) => def.turnInto)

const popupClass = cx(
  "card-2 z-20 grid place-items-stretch overflow-hidden rounded-lg print:hidden outline-hidden",
  "popup-motion origin-(--transform-origin)",
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
        <ContextMenu.Positioner className="outline-none">
          <ContextMenu.Popup
            data-testid="block-context-menu"
            className={popupClass}
            style={{ width: 240 }}
          >
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
  const { key, id } = target
  const shared = target.places > 1
  const image = target.type === "image"
  const link = target.type === "link"
  const figure = target.figure !== undefined
  const links = target.links ?? []
  const entries: MenuEntry[] = []
  const item = (e: Omit<Extract<MenuEntry, { kind: "item" }>, "kind">) =>
    entries.push({ kind: "item", ...e })
  const rule = () => entries.push({ kind: "separator" })

  item({
    label: image ? "Edit caption" : link ? "Edit title" : "Edit",
    shortcut: ["↵"],
    onSelect: () => actions.edit(key),
  })
  // A link's card, for a screen with nothing to hover with: the one link
  // straight away, several by their display text.
  if (links.length === 1 && actions.editLink) {
    item({ label: "Edit link", onSelect: () => actions.editLink?.(key, links[0].href) })
  } else if (links.length > 1 && actions.editLink) {
    entries.push({
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
    entries.push({
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
  // A figure is its picture or its page: "turn into" would only keep the
  // caption or the title. A link block goes back to the inline link it was
  // made from instead.
  if (link && actions.linkToInline)
    item({ label: "Turn into inline", onSelect: () => actions.linkToInline?.(id) })
  if (!figure) {
    entries.push({
      kind: "group",
      label: "Turn into",
      width: 200,
      items: [
        ...TYPES.map((def) => ({
          key: def.id,
          label: def.label,
          // A checked todo is a to-do for the tick; every heading level is
          // a heading.
          selected: canonicalOf(target.type) === def.id,
          onSelect: () => actions.setType(id, def.id),
        })),
        // Not a type change: the row's first link becomes a link block, in
        // place or beneath (docs/links.md). Offered only where there is a
        // link to make it of.
        ...(links.length > 0 && actions.turnIntoLink
          ? [
              {
                key: "link",
                label: "Link",
                onSelect: () => actions.turnIntoLink?.(key, links[0].href, links[0].title),
              },
            ]
          : []),
      ],
    })
  }
  rule()
  item({ label: "Duplicate", shortcut: ["⌥", "⇧", "↓"], onSelect: () => actions.duplicate(key) })
  rule()
  item({ label: "Indent", shortcut: ["⇥"], onSelect: () => actions.indent(key) })
  item({ label: "Outdent", shortcut: ["⇧", "⇥"], onSelect: () => actions.outdent(key) })
  item({ label: "Move up", shortcut: ["⌥", "↑"], onSelect: () => actions.moveUp(key) })
  item({ label: "Move down", shortcut: ["⌥", "↓"], onSelect: () => actions.moveDown(key) })
  rule()
  if (target.hasChildren) {
    item({
      label: target.collapsed ? "Expand" : "Collapse",
      shortcut: ["Space"],
      onSelect: () => actions.toggleCollapse(key),
    })
  }
  item({ label: "Focus on", shortcut: ["F"], onSelect: () => actions.focusBlock(id) })
  item({ label: "Copy", shortcut: ["⌘", "C"], onSelect: () => actions.copy(key) })
  if (actions.copyLink)
    item({ label: "Copy link to block", onSelect: () => actions.copyLink?.(id) })
  if (actions.pin)
    item({ label: target.pinned ? "Unpin" : "Pin", onSelect: () => actions.pin?.(id) })
  if (actions.share) item({ label: "Share…", onSelect: () => actions.share?.(id) })
  rule()
  if (actions.deleteEverywhere) {
    item({ label: "Unlink", shortcut: ["⌫"], onSelect: () => actions.remove(key) })
    item({
      label: "Delete",
      danger: true,
      trailing: shared ? (
        <span className="text-sm text-text-secondary">{target.places} places</span>
      ) : undefined,
      onSelect: () => actions.deleteEverywhere?.(id),
    })
  } else {
    item({ label: "Delete", danger: true, shortcut: ["⌫"], onSelect: () => actions.remove(key) })
    if (actions.deleteSubtree && target.hasChildren) {
      item({
        label: "Delete with contents",
        danger: true,
        onSelect: () => actions.deleteSubtree?.(id),
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
              <SubmenuTrigger>{entry.label}</SubmenuTrigger>
              <Menu.Portal>
                <Menu.Positioner side="right" align="start" sideOffset={4}>
                  <Menu.Popup className={popupClass} style={{ width: entry.width ?? 200 }}>
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
 */
export function BlockMenuSheet({
  target,
  title,
  actions,
  open,
  onOpenChange,
}: {
  target: BlockMenuTarget | null
  /** The block's text, for the sheet's heading. */
  title: string
  actions: BlockMenuActions
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const entries = target ? menuEntries(target, actions) : []
  const pick = (run: () => void) => () => {
    onOpenChange(false)
    run()
  }
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange} shouldScaleBackground={false}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-30 bg-linear-to-t from-[#000000] to-[#00000000]" />
        <Drawer.Content
          data-testid="block-menu-sheet"
          className="fixed bottom-0 left-0 right-0 z-30 flex max-h-[85svh] flex-col rounded-t-xl bg-bg-overlay pb-[env(safe-area-inset-bottom)] outline-none"
        >
          <div aria-hidden className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-border" />
          <Drawer.Title className="truncate px-5 pt-3 pb-1 text-sm text-text-secondary">
            {title.trim() || "Block"}
          </Drawer.Title>
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
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
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
