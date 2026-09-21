import { Menu } from "@base-ui/react/menu"
import { useRef } from "react"
import { createPortal } from "react-dom"
import type React from "react"
import { BLOCK_TYPE_DEFS } from "../../blocks/registry"
import type { BlockType } from "../../blocks/types"
import { cx } from "../../utils/cx"
import {
  ArrowLeftToLineIcon16,
  ArrowRightToLineIcon16,
  ChevronDownIcon16,
  TrashIcon16,
  XIcon16,
} from "../icons"
import { Button } from "../ui/button"
import { DropdownMenu } from "../ui/dropdown-menu"
import { IconButton } from "../ui/icon-button"
import { Surface } from "../ui/surface"

/** What the bar can do to the selected rows: the same actions the keys run
 * on a multi-row selection (docs/keyboard-shortcuts.md, Multi-select), each
 * on every selected block at once. */
export interface SelectionBarActions {
  indent: () => void
  outdent: () => void
  moveUp: () => void
  moveDown: () => void
  duplicate: () => void
  turnInto: (type: BlockType) => void
  copy: () => void
  cut: () => void
  remove: () => void
  /** Back to one highlighted block — what <kbd>Esc</kbd> does. */
  clear: () => void
}

/** What the selection can take right now: a button whose action would do
 * nothing is greyed, as on the touch screen's edit bar. */
export interface SelectionBarState {
  canIndent: boolean
  canOutdent: boolean
  canMoveUp: boolean
  canMoveDown: boolean
}

/** The types the selection can be turned into: the registry's, in its
 * order (the block menu's Turn into offers the same). */
const TYPES = BLOCK_TYPE_DEFS.filter((def) => def.turnInto)

/** A click on a bar button leaves the keyboard where it is — in the editor,
 * whose selection the button acts on — so the highlight never dims for the
 * click that means to use it. (Enter on a focused button still works.) */
const keepFocus = (event: React.MouseEvent) => event.preventDefault()

/**
 * The floating bar over a multi-row selection: how many rows are selected,
 * the structural moves as buttons, and every bulk action in one menu — for
 * a pointer that selected a run of blocks and has no key to hand for what
 * comes next. It sits at the bottom of the window, centred, clear of the
 * rows it is about, and rises into place from just below its resting spot
 * under a fade — and sinks back out the same way when the selection
 * collapses — the way a toolbar for a selection does in Linear.
 *
 * Kept mounted and hidden rather than unmounted, so the departure has
 * something to play on: the browser's discrete `display` transition holds
 * it on screen for the fade, and `@starting-style` gives it the arrival
 * (the same two moments `Surface` uses for a popup nothing holds). The
 * count shown while it leaves is the last one it had, not zero.
 *
 * `finalFocus` is where the menu hands the keyboard back on closing: the
 * editor's container, not the menu's own trigger, so the arrows work again
 * the moment an action has run.
 */
export function SelectionBar({
  open,
  count,
  state,
  actions,
  finalFocus,
}: {
  open: boolean
  count: number
  state: SelectionBarState
  actions: SelectionBarActions
  finalFocus: React.RefObject<HTMLElement | null>
}) {
  const shown = useRef(count)
  if (open) shown.current = count
  if (typeof document === "undefined") return null
  return createPortal(
    <div
      data-selection-bar
      role="toolbar"
      aria-label="Selected blocks"
      aria-hidden={!open || undefined}
      className={cx(
        "pointer-events-none fixed inset-x-0 bottom-4 z-raised flex justify-center px-4 print:hidden",
        // The arrival and the departure: a fade, and (where motion is
        // welcome) a short rise from below. The `display` flip is discrete,
        // so the bar stays on screen until the exit has played.
        "transition-[opacity,translate,display] transition-discrete duration-base ease-(--ease-out-strong)",
        "starting:opacity-0 motion-safe:starting:translate-y-3",
        !open && "hidden opacity-0 motion-safe:translate-y-3",
      )}
    >
      <Surface
        tier="popup"
        motion={false}
        className="pointer-events-auto flex items-center gap-0.5 p-1 text-sm"
      >
        <span className="px-2 tabular-nums text-text-secondary" data-testid="selection-count">
          {shown.current} selected
        </span>
        <IconButton
          size="small"
          aria-label="Clear selection"
          shortcut={["Esc"]}
          tooltipSide="top"
          onMouseDown={keepFocus}
          onClick={actions.clear}
        >
          <XIcon16 />
        </IconButton>
        <Rule />
        <IconButton
          size="small"
          aria-label="Indent"
          shortcut={["⇥"]}
          tooltipSide="top"
          disabled={!state.canIndent}
          onMouseDown={keepFocus}
          onClick={actions.indent}
        >
          <ArrowRightToLineIcon16 />
        </IconButton>
        <IconButton
          size="small"
          aria-label="Outdent"
          shortcut={["⇧", "⇥"]}
          tooltipSide="top"
          disabled={!state.canOutdent}
          onMouseDown={keepFocus}
          onClick={actions.outdent}
        >
          <ArrowLeftToLineIcon16 />
        </IconButton>
        <IconButton
          size="small"
          aria-label="Remove"
          shortcut={["⌫"]}
          tooltipSide="top"
          onMouseDown={keepFocus}
          onClick={actions.remove}
        >
          <TrashIcon16 />
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
                        <DropdownMenu.Item key={def.id} onClick={() => actions.turnInto(def.id)}>
                          {def.label}
                        </DropdownMenu.Item>
                      ))}
                    </div>
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.SubmenuRoot>
            <DropdownMenu.Separator />
            <DropdownMenu.Item shortcut={["⌥", "⇧", "↓"]} onClick={actions.duplicate}>
              Duplicate
            </DropdownMenu.Item>
            <DropdownMenu.Separator />
            <DropdownMenu.Item
              shortcut={["⇥"]}
              disabled={!state.canIndent}
              onClick={actions.indent}
            >
              Indent
            </DropdownMenu.Item>
            <DropdownMenu.Item
              shortcut={["⇧", "⇥"]}
              disabled={!state.canOutdent}
              onClick={actions.outdent}
            >
              Outdent
            </DropdownMenu.Item>
            <DropdownMenu.Item
              shortcut={["⌥", "↑"]}
              disabled={!state.canMoveUp}
              onClick={actions.moveUp}
            >
              Move up
            </DropdownMenu.Item>
            <DropdownMenu.Item
              shortcut={["⌥", "↓"]}
              disabled={!state.canMoveDown}
              onClick={actions.moveDown}
            >
              Move down
            </DropdownMenu.Item>
            <DropdownMenu.Separator />
            <DropdownMenu.Item shortcut={["⌘", "C"]} onClick={actions.copy}>
              Copy
            </DropdownMenu.Item>
            <DropdownMenu.Item shortcut={["⌘", "X"]} onClick={actions.cut}>
              Cut
            </DropdownMenu.Item>
            <DropdownMenu.Separator />
            <DropdownMenu.Item shortcut={["⌫"]} variant="danger" onClick={actions.remove}>
              Remove
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu>
      </Surface>
    </div>,
    document.body,
  )
}

/** A hairline between the bar's groups. */
function Rule() {
  return <span aria-hidden className="mx-1 h-4 w-px bg-border-secondary" />
}
