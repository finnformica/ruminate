import { ContextMenu } from "@base-ui/react/context-menu"
import { Menu } from "@base-ui/react/menu"
import React from "react"
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
 * **Pin** puts the block in the sidebar's Pinned list (docs/metadata.md),
 * from where it opens zoomed into; on a pinned block the item reads Unpin.
 *
 * Structure moves (indent, outdent, move up/down) are keyboard-only: the
 * menu is for what a pointer cannot already do.
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
  /** Pinned (docs/metadata.md): listed in the sidebar's Pinned list. */
  pinned: boolean
  /** A figure row's layout (`src/blocks/figure.ts`): the side its picture
   * or card keeps to, and whether it has been dragged to a size of its own. */
  figure?: { align: FigureAlign; sized: boolean }
}

export interface BlockMenuActions {
  edit: (key: string) => void
  setType: (id: string, type: BlockType) => void
  duplicate: (key: string) => void
  toggleCollapse: (key: string) => void
  zoomInto: (id: string) => void
  copy: (key: string) => void
  /** Absent when the editor has no note to link into (Storybook, tests). */
  copyLink?: (id: string) => void
  /** Pin this block — or unpin it, when it is (`target.pinned`): a pinned
   * block is listed in the sidebar under Pinned and opens zoomed into.
   * Absent where the rows are not the user's own to pin. */
  pin?: (id: string) => void
  /** Share this block — and everything beneath it — with someone
   * (docs/sharing.md). Absent where the rows are not the user's own. */
  share?: (id: string) => void
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
  "origin-(--transform-origin) transition-[transform,scale,opacity] data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
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

function Items({ target, actions }: { target: BlockMenuTarget; actions: BlockMenuActions }) {
  const { key, id } = target
  const shared = target.places > 1
  const image = target.type === "image"
  const link = target.type === "link"
  const figure = target.figure !== undefined
  return (
    <>
      <DropdownMenu.Item shortcut={["↵"]} onClick={() => actions.edit(key)}>
        {image ? "Edit caption" : link ? "Edit title" : "Edit"}
      </DropdownMenu.Item>
      {image && actions.openImage ? (
        <DropdownMenu.Item onClick={() => actions.openImage?.(id)}>Open image</DropdownMenu.Item>
      ) : null}
      {image && actions.downloadImage ? (
        <DropdownMenu.Item onClick={() => actions.downloadImage?.(id)}>
          Download image
        </DropdownMenu.Item>
      ) : null}
      {link && actions.openLink ? (
        <DropdownMenu.Item onClick={() => actions.openLink?.(id)}>Open link</DropdownMenu.Item>
      ) : null}
      {link && actions.refreshPreview ? (
        <DropdownMenu.Item onClick={() => actions.refreshPreview?.(id)}>
          Refresh preview
        </DropdownMenu.Item>
      ) : null}
      {/* A figure's layout: the side it keeps to (the frame's own toolbar
          offers the same), and its natural width back after a drag. */}
      {figure && actions.alignFigure ? (
        <Menu.SubmenuRoot>
          <SubmenuTrigger>Align</SubmenuTrigger>
          <Menu.Portal>
            <Menu.Positioner side="right" align="start" sideOffset={4}>
              <Menu.Popup className={popupClass} style={{ width: 160 }}>
                <div className="grid p-1" data-testid="figure-align-menu">
                  {FIGURE_ALIGNS.map((align) => (
                    <DropdownMenu.Item
                      key={align}
                      selected={target.figure?.align === align}
                      onClick={() => actions.alignFigure?.(id, align)}
                    >
                      {ALIGN_LABELS[align]}
                    </DropdownMenu.Item>
                  ))}
                </div>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.SubmenuRoot>
      ) : null}
      {figure && target.figure?.sized && actions.resetFigureSize ? (
        <DropdownMenu.Item onClick={() => actions.resetFigureSize?.(id)}>
          {image ? "Original size" : "Full width"}
        </DropdownMenu.Item>
      ) : null}
      {/* A figure is its picture or its page: "turn into" would only keep
          the caption or the title. A link block goes back to the inline
          link it was made from instead. */}
      {link && actions.linkToInline ? (
        <DropdownMenu.Item onClick={() => actions.linkToInline?.(id)}>
          Turn into inline
        </DropdownMenu.Item>
      ) : null}
      {figure ? null : (
        <Menu.SubmenuRoot>
          <SubmenuTrigger>Turn into</SubmenuTrigger>
          <Menu.Portal>
            <Menu.Positioner side="right" align="start" sideOffset={4}>
              <Menu.Popup className={popupClass} style={{ width: 200 }}>
                <div className="grid p-1">
                  {TYPES.map((def) => (
                    <DropdownMenu.Item
                      key={def.id}
                      // A checked todo is a to-do for the tick; every heading
                      // level is a heading.
                      selected={canonicalOf(target.type) === def.id}
                      onClick={() => actions.setType(id, def.id)}
                    >
                      {def.label}
                    </DropdownMenu.Item>
                  ))}
                </div>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.SubmenuRoot>
      )}
      <DropdownMenu.Separator />
      <DropdownMenu.Item shortcut={["⌥", "⇧", "↓"]} onClick={() => actions.duplicate(key)}>
        Duplicate
      </DropdownMenu.Item>
      <DropdownMenu.Separator />
      {target.hasChildren ? (
        <DropdownMenu.Item shortcut={["Space"]} onClick={() => actions.toggleCollapse(key)}>
          {target.collapsed ? "Expand" : "Collapse"}
        </DropdownMenu.Item>
      ) : null}
      <DropdownMenu.Item shortcut={["F"]} onClick={() => actions.zoomInto(id)}>
        Zoom into
      </DropdownMenu.Item>
      <DropdownMenu.Item shortcut={["⌘", "C"]} onClick={() => actions.copy(key)}>
        Copy
      </DropdownMenu.Item>
      {actions.copyLink ? (
        <DropdownMenu.Item onClick={() => actions.copyLink?.(id)}>
          Copy link to block
        </DropdownMenu.Item>
      ) : null}
      {actions.pin ? (
        <DropdownMenu.Item onClick={() => actions.pin?.(id)}>
          {target.pinned ? "Unpin" : "Pin"}
        </DropdownMenu.Item>
      ) : null}
      {actions.share ? (
        <DropdownMenu.Item onClick={() => actions.share?.(id)}>Share…</DropdownMenu.Item>
      ) : null}
      <DropdownMenu.Separator />
      {actions.deleteEverywhere ? (
        <>
          <DropdownMenu.Item shortcut={["⌫"]} onClick={() => actions.remove(key)}>
            Unlink
          </DropdownMenu.Item>
          <DropdownMenu.Item
            variant="danger"
            trailingVisual={
              shared ? (
                <span className="text-sm text-text-secondary">{target.places} places</span>
              ) : undefined
            }
            onClick={() => actions.deleteEverywhere?.(id)}
          >
            Delete
          </DropdownMenu.Item>
        </>
      ) : (
        <>
          <DropdownMenu.Item variant="danger" shortcut={["⌫"]} onClick={() => actions.remove(key)}>
            Delete
          </DropdownMenu.Item>
          {actions.deleteSubtree && target.hasChildren ? (
            <DropdownMenu.Item variant="danger" onClick={() => actions.deleteSubtree?.(id)}>
              Delete with contents
            </DropdownMenu.Item>
          ) : null}
        </>
      )}
    </>
  )
}
