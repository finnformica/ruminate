import { Menu } from "@base-ui/react/menu"
import { useRef } from "react"
import type React from "react"
import { BLOCK_TYPE_DEFS } from "../../blocks/registry"
import type { BlockActions } from "./block-actions"
import { ChevronDownIcon16, XIcon16 } from "../icons"
import { Button } from "../ui/button"
import { DropdownMenu } from "../ui/dropdown-menu"
import { IconButton } from "../ui/icon-button"
import { FloatingBar } from "../ui/floating-bar"
import { Surface } from "../ui/surface"

/** The types the selection can be turned into: the registry's, in its
 * order (the block menu's Turn into offers the same). */
const TYPES = BLOCK_TYPE_DEFS.filter((def) => def.turnInto)

/** A click on a bar button leaves the keyboard where it is — in the editor,
 * whose selection the button acts on — so the highlight never dims for the
 * click that means to use it. (Enter on a focused button still works.) */
const keepFocus = (event: React.MouseEvent) => event.preventDefault()

/**
 * The floating bar over a multi-row selection: how many rows are selected,
 * a way out, and every bulk action in one menu — for a pointer that
 * selected a run of blocks and has no key to hand for what comes next. A
 * `FloatingBar` (src/components/ui/floating-bar.tsx): at the bottom of the
 * window, centred, clear of the rows it is about, rising into place under
 * a fade and sinking back out when the selection collapses — the way a
 * toolbar for a selection does in Linear. The count shown while it leaves
 * is the last one it had, not zero.
 *
 * `finalFocus` is where the menu hands the keyboard back on closing: the
 * editor's container, not the menu's own trigger, so the arrows work again
 * the moment an action has run.
 */
export function SelectionBar({
  open,
  count,
  keys,
  actions,
  onClear,
  removal = "unlink",
  finalFocus,
}: {
  open: boolean
  count: number
  /** The rows the bar acts on: the selection's roots. */
  keys: string[]
  /** The editor's one set of block actions (`block-actions.ts`) — the same
   * object the right-click menu runs; the bar runs each over `keys`. An
   * item whose action would do nothing is greyed (`actions.moves`). */
  actions: BlockActions
  /** Back to one highlighted block — what <kbd>Esc</kbd> does. */
  onClear: () => void
  /** What removing the rows means, as the block menu words it: **Unlink**
   * in a note's outline (the blocks stay), **Delete** where the row's
   * removal is the delete (the basket, editors with no graph behind them). */
  removal?: "unlink" | "delete"
  finalFocus: React.RefObject<HTMLElement | null>
}) {
  const shown = useRef(count)
  if (open) shown.current = count
  const state = actions.moves(keys)
  return (
    <FloatingBar open={open} label="Selected blocks" data-selection-bar>
      <span className="px-2 tabular-nums text-text-secondary" data-testid="selection-count">
        {shown.current} selected
      </span>
      <IconButton
        size="small"
        aria-label="Clear selection"
        shortcut={["Esc"]}
        tooltipSide="top"
        onMouseDown={keepFocus}
        onClick={onClear}
      >
        <XIcon16 />
      </IconButton>
      <Rule />
      <DropdownMenu>
        <DropdownMenu.Trigger
          render={
            <Button size="small" className="gap-1 pr-1.5">
              Actions
              <ChevronDownIcon16 />
            </Button>
          }
        />
        <DropdownMenu.Content side="top" align="end" sideOffset={8} finalFocus={finalFocus}>
          <Menu.SubmenuRoot>
            <DropdownMenu.SubmenuTrigger>Turn into</DropdownMenu.SubmenuTrigger>
            <Menu.Portal>
              <Menu.Positioner className="z-popup" side="right" align="start" sideOffset={4}>
                <Menu.Popup
                  render={<Surface className="grid overflow-hidden outline-hidden" />}
                  style={{ width: 200 }}
                >
                  <div className="grid p-1" data-testid="selection-turn-into">
                    {TYPES.map((def) => (
                      <DropdownMenu.Item
                        key={def.id}
                        onClick={() => actions.turnInto(keys, def.id)}
                      >
                        {def.label}
                      </DropdownMenu.Item>
                    ))}
                  </div>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.SubmenuRoot>
          <DropdownMenu.Separator />
          <DropdownMenu.Item shortcut={["⌥", "⇧", "↓"]} onClick={() => actions.duplicate(keys)}>
            Duplicate
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item
            shortcut={["⇥"]}
            disabled={!state.canIndent}
            onClick={() => actions.indent(keys)}
          >
            Indent
          </DropdownMenu.Item>
          <DropdownMenu.Item
            shortcut={["⇧", "⇥"]}
            disabled={!state.canOutdent}
            onClick={() => actions.outdent(keys)}
          >
            Outdent
          </DropdownMenu.Item>
          <DropdownMenu.Item
            shortcut={["⌥", "↑"]}
            disabled={!state.canMoveUp}
            onClick={() => actions.moveUp(keys)}
          >
            Move up
          </DropdownMenu.Item>
          <DropdownMenu.Item
            shortcut={["⌥", "↓"]}
            disabled={!state.canMoveDown}
            onClick={() => actions.moveDown(keys)}
          >
            Move down
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item shortcut={["⌘", "C"]} onClick={() => actions.copy(keys)}>
            Copy
          </DropdownMenu.Item>
          <DropdownMenu.Item shortcut={["⌘", "X"]} onClick={() => actions.cut(keys)}>
            Cut
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item
            shortcut={["⌫"]}
            variant={removal === "delete" ? "danger" : undefined}
            onClick={() => actions.remove(keys)}
          >
            {removal === "unlink" ? "Unlink" : "Delete"}
          </DropdownMenu.Item>
          {actions.deleteEverywhere ? (
            <DropdownMenu.Item variant="danger" onClick={() => actions.deleteEverywhere?.(keys)}>
              Delete
            </DropdownMenu.Item>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu>
    </FloatingBar>
  )
}

/** A hairline between the bar's groups. */
function Rule() {
  return <span aria-hidden className="mx-1 h-4 w-px bg-border-secondary" />
}
