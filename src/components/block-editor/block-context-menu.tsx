import { ContextMenu } from "@base-ui/react/context-menu"
import { Menu } from "@base-ui/react/menu"
import React from "react"
import { IMAGE_ALIGNS, type ImageAlign } from "../../blocks/image"
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
  /** An image row's layout (`src/blocks/image.ts`): the side its picture
   * keeps to, and whether it has been dragged to a size of its own. */
  image?: { align: ImageAlign; sized: boolean }
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
  /** Image rows: which side of the row the picture keeps to. */
  alignImage?: (id: string, align: ImageAlign) => void
  /** Image rows: return a dragged picture to its natural size. */
  resetImageSize?: (id: string) => void
}

/** The Align submenu's items, in the order the figure's toolbar has them. */
const ALIGN_LABELS: Record<ImageAlign, string> = {
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
  return (
    <>
      <DropdownMenu.Item shortcut={["↵"]} onClick={() => actions.edit(key)}>
        {image ? "Edit caption" : "Edit"}
      </DropdownMenu.Item>
      {image && actions.openImage ? (
        <DropdownMenu.Item onClick={() => actions.openImage?.(id)}>Open image</DropdownMenu.Item>
      ) : null}
      {image && actions.downloadImage ? (
        <DropdownMenu.Item onClick={() => actions.downloadImage?.(id)}>
          Download image
        </DropdownMenu.Item>
      ) : null}
      {/* An image's layout: the side it keeps to (the figure's own toolbar
          offers the same), and its natural size back after a drag. */}
      {image && target.image && actions.alignImage ? (
        <Menu.SubmenuRoot>
          <SubmenuTrigger>Align</SubmenuTrigger>
          <Menu.Portal>
            <Menu.Positioner side="right" align="start" sideOffset={4}>
              <Menu.Popup className={popupClass} style={{ width: 160 }}>
                <div className="grid p-1" data-testid="image-align-menu">
                  {IMAGE_ALIGNS.map((align) => (
                    <DropdownMenu.Item
                      key={align}
                      selected={target.image?.align === align}
                      onClick={() => actions.alignImage?.(id, align)}
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
      {image && target.image?.sized && actions.resetImageSize ? (
        <DropdownMenu.Item onClick={() => actions.resetImageSize?.(id)}>
          Original size
        </DropdownMenu.Item>
      ) : null}
      {/* An image is its picture: "turn into" would only keep the caption. */}
      {image ? null : (
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
