import { ContextMenu } from "@base-ui/react/context-menu"
import { Menu } from "@base-ui/react/menu"
import React from "react"
import { BLOCK_TYPE_DEFS, canonicalOf } from "../../blocks/registry"
import type { BlockType } from "../../blocks/types"
import { cx } from "../../utils/cx"
import { DropdownMenu } from "../dropdown-menu"
import { CopyIcon16, EditIcon16, TrashIcon16 } from "../icons"

/**
 * The block's right-click menu: the standard actions on one row, the same
 * commands the keyboard runs, so nothing here has a second meaning. Opened
 * by the editor on any row it owns (never in read-only views); the editor
 * supplies the row (`target`) and the actions, this file the menu.
 *
 * Deleting is graph-aware. A row is one place a block appears. On a block
 * held only here, **Delete** removes the row (the editor's undoable
 * delete). On a block held in more than one place the menu offers
 * **Unlink**, which takes it out of this place and leaves it everywhere
 * else, and **Delete**, which removes the block itself from every place it
 * appears (`deleteBlockOps`), with the place count beside it so the reach
 * is clear.
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
  /** Image rows: expand the picture, and save it to the device. */
  openImage?: (id: string) => void
  downloadImage?: (id: string) => void
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
  onOpenChange?: (open: boolean) => void
  children: React.ReactNode
}) {
  return (
    <ContextMenu.Root onOpenChange={onOpenChange}>
      <ContextMenu.Trigger>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="outline-none">
          <ContextMenu.Popup
            data-testid="block-context-menu"
            className={popupClass}
            style={{ width: 240 }}
          >
            <div className="grid max-h-[45svh] scroll-py-1 overflow-auto p-1">
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
      <DropdownMenu.Item icon={<EditIcon16 />} shortcut={["↵"]} onClick={() => actions.edit(key)}>
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
      {/* An image is its picture: "turn into" would only keep the caption. */}
      {image ? null : (
        <Menu.SubmenuRoot>
          <Menu.SubmenuTrigger className="group flex h-8 cursor-pointer select-none items-center gap-3 rounded px-3 outline-hidden focus:bg-bg-hover data-[popup-open]:bg-bg-hover coarse:h-10">
            <div className="flex w-0 grow items-center gap-3">
              <div className="flex w-4 text-text-secondary" />
              <span className="grow truncate">Turn into</span>
            </div>
            <span aria-hidden className="text-text-tertiary">
              ›
            </span>
          </Menu.SubmenuTrigger>
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
      <DropdownMenu.Item
        icon={<CopyIcon16 />}
        shortcut={["⌘", "C"]}
        onClick={() => actions.copy(key)}
      >
        Copy
      </DropdownMenu.Item>
      {actions.copyLink ? (
        <DropdownMenu.Item onClick={() => actions.copyLink?.(id)}>
          Copy link to block
        </DropdownMenu.Item>
      ) : null}
      <DropdownMenu.Separator />
      {shared && actions.deleteEverywhere ? (
        <>
          <DropdownMenu.Item shortcut={["⌫"]} onClick={() => actions.remove(key)}>
            Unlink
          </DropdownMenu.Item>
          <DropdownMenu.Item
            icon={<TrashIcon16 />}
            variant="danger"
            trailingVisual={
              <span className="text-sm text-text-secondary">{target.places} places</span>
            }
            onClick={() => actions.deleteEverywhere?.(id)}
          >
            Delete
          </DropdownMenu.Item>
        </>
      ) : (
        <DropdownMenu.Item
          icon={<TrashIcon16 />}
          variant="danger"
          shortcut={["⌫"]}
          onClick={() => actions.remove(key)}
        >
          Delete
        </DropdownMenu.Item>
      )}
    </>
  )
}
