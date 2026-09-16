import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import type React from "react"
import { cx } from "../../utils/cx"
import {
  ArrowDownIcon16,
  ArrowLeftToLineIcon16,
  ArrowRightToLineIcon16,
  ArrowUpIcon16,
  RedoIcon16,
  UndoIcon16,
} from "../icons"

/** What the bar can do to the row being edited: the same commands the keys
 * run (`src/blocks/commands.ts`), plus `done`, which ends the edit. */
export interface MobileEditBarActions {
  indent: () => void
  outdent: () => void
  moveUp: () => void
  moveDown: () => void
  undo: () => void
  redo: () => void
  done: () => void
}

/**
 * How far the visual viewport's bottom sits above the layout viewport's —
 * the height of a keyboard that overlays the page rather than resizing it
 * (iOS Safari; Chrome on Android resizes the page, see the viewport meta's
 * `interactive-widget=resizes-content`, and reports 0). Tracked live, so a
 * bar fixed at `bottom: offset` rides the keyboard up and down.
 */
function useKeyboardInset(): number {
  const [inset, setInset] = useState(0)
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const measure = () => {
      const next = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
      setInset(Math.round(next))
    }
    measure()
    viewport.addEventListener("resize", measure)
    viewport.addEventListener("scroll", measure)
    return () => {
      viewport.removeEventListener("resize", measure)
      viewport.removeEventListener("scroll", measure)
    }
  }, [])
  return inset
}

/**
 * The edit bar a touch screen gets above its keyboard while a block is being
 * edited: the structure moves a virtual keyboard has no keys for — outdent,
 * indent, move up, move down — undo and redo, and Done, which puts the
 * keyboard away and leaves the row highlighted. Fixed to the bottom of the
 * visual viewport, so it sits on the keyboard whether the keyboard overlays
 * the page (iOS) or shrinks it (Android). Every button cancels its pointer
 * down, so a tap never takes focus from the textarea — which would end the
 * edit and dismiss the keyboard the bar sits on.
 */
export function MobileEditBar({ actions }: { actions: MobileEditBarActions }) {
  const inset = useKeyboardInset()
  if (typeof document === "undefined") return null
  return createPortal(
    <div
      role="toolbar"
      aria-label="Editing"
      data-testid="mobile-edit-bar"
      className="fixed inset-x-0 z-20 flex items-stretch border-t border-border-secondary bg-bg-overlay print:hidden"
      style={{
        bottom: inset,
        // Under a keyboard the safe area is the keyboard's; without one the
        // bar sits on the home indicator and keeps clear of it.
        paddingBottom: inset > 0 ? 0 : "env(safe-area-inset-bottom)",
      }}
    >
      <BarButton label="Outdent" onClick={actions.outdent}>
        <ArrowLeftToLineIcon16 />
      </BarButton>
      <BarButton label="Indent" onClick={actions.indent}>
        <ArrowRightToLineIcon16 />
      </BarButton>
      <BarButton label="Move up" onClick={actions.moveUp}>
        <ArrowUpIcon16 />
      </BarButton>
      <BarButton label="Move down" onClick={actions.moveDown}>
        <ArrowDownIcon16 />
      </BarButton>
      <BarButton label="Undo" onClick={actions.undo}>
        <UndoIcon16 />
      </BarButton>
      <BarButton label="Redo" onClick={actions.redo}>
        <RedoIcon16 />
      </BarButton>
      <BarButton
        label="Done"
        onClick={actions.done}
        className="ml-auto px-4 font-semibold text-text"
      >
        Done
      </BarButton>
    </div>,
    document.body,
  )
}

/** Keeps focus where it is: the pointer down is cancelled, so the textarea
 * never blurs and the keyboard stays up for the tap that follows. */
const keepFocus = (event: React.SyntheticEvent) => event.preventDefault()

function BarButton({
  label,
  onClick,
  className,
  children,
}: {
  label: string
  onClick: () => void
  className?: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      tabIndex={-1}
      onPointerDown={keepFocus}
      onMouseDown={keepFocus}
      onClick={onClick}
      className={cx(
        "flex h-11 min-w-11 flex-1 cursor-pointer select-none items-center justify-center text-text-secondary active:bg-bg-active",
        className,
      )}
    >
      {children}
    </button>
  )
}
