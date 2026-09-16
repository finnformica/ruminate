import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type React from "react"
import { BLOCK_TYPE_DEFS, canonicalOf } from "../../blocks/registry"
import type { BlockType } from "../../blocks/types"
import { cx } from "../../utils/cx"
import {
  ArrowDownIcon16,
  ArrowLeftToLineIcon16,
  ArrowRightToLineIcon16,
  ArrowUpIcon16,
  ChevronLeftIcon16,
  CopyIcon16,
  PaperclipIcon16,
  TrashIcon16,
} from "../icons"

/** What the bar can do to the row being edited: the same commands the keys
 * and the block menu run (`src/blocks/commands.ts`), plus `done`. */
export interface MobileEditBarActions {
  turnInto: (type: BlockType) => void
  bold: () => void
  italic: () => void
  code: () => void
  indent: () => void
  outdent: () => void
  moveUp: () => void
  moveDown: () => void
  duplicate: () => void
  remove: () => void
  /** Add a picture at this row; absent where images are switched off. */
  image?: () => void
  /** End the edit and put the keyboard away. */
  done: () => void
}

/** The types a block can be turned into: the registry's, in its order (the
 * block menu's Turn into offers the same). */
const TYPES = BLOCK_TYPE_DEFS.filter((def) => def.turnInto)

/** A keyboard is at least this tall; the browser's own chrome (the address
 * bar coming and going, iOS 26.0's 24px that never comes back) moves the
 * viewport by less. */
const KEYBOARD_MIN_HEIGHT = 150

/** The CSS variable the page pads its scroller by while the bar is up
 * (`page-layout.tsx`): what the keyboard and the bar together cover, so the
 * end of a note can still be scrolled above them. */
const INSET_VAR = "--edit-bar-inset"

interface KeyboardState {
  /** The visual viewport's bottom edge, in the layout viewport's
   * coordinates — where the bar's bottom edge goes. */
  bottom: number
  /** The keyboard is up: the visual viewport is a keyboard's height short of
   * the tallest it has been since the edit began. */
  keyboardUp: boolean
}

function readKeyboard(): { bottom: number; height: number } {
  const viewport = window.visualViewport
  if (!viewport) return { bottom: window.innerHeight, height: window.innerHeight }
  return { bottom: viewport.offsetTop + viewport.height, height: viewport.height }
}

/**
 * Where the keyboard is, read from the visual viewport (`window.visualViewport`).
 * A `position: fixed` element sits in the LAYOUT viewport, which an
 * overlaying keyboard (iOS Safari) does not shrink — so a bar at `bottom: 0`
 * is under the keyboard. The visual viewport is what is actually on screen:
 * the bar is pinned to its bottom edge instead, top-anchored and pulled up
 * by its own height, using nothing but the visual viewport's own numbers
 * (its `offsetTop` is in layout coordinates, as `top` is). Where the
 * keyboard shrinks the page instead (Chrome on Android, with the viewport
 * meta's `interactive-widget=resizes-content`) the two viewports agree and
 * the bar lands at the bottom of the page as before. Read on the viewport's
 * `resize` and `scroll`, the window's too, and on a slow poll besides: iOS
 * does not always announce the keyboard's moves.
 *
 * The keyboard going away is the viewport growing back by a keyboard's
 * height, after having shrunk by one; `onClose` is called once for it. (On
 * iOS the Done key also blurs the textarea, which ends the edit first; on
 * Android the Back key hides the keyboard with no blur, and this is the only
 * word of it.)
 */
function useKeyboard(onClose: () => void): KeyboardState {
  const [state, setState] = useState<KeyboardState>(() => ({
    bottom: typeof window === "undefined" ? 0 : readKeyboard().bottom,
    keyboardUp: false,
  }))
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    let tallest = readKeyboard().height
    let wasUp = false
    let closed = false
    const measure = () => {
      const { bottom, height } = readKeyboard()
      if (height > tallest) tallest = height
      const keyboardUp = tallest - height > KEYBOARD_MIN_HEIGHT
      if (wasUp && !keyboardUp && !closed) {
        closed = true
        close.current()
      }
      wasUp = keyboardUp
      setState((prev) =>
        prev.bottom === bottom && prev.keyboardUp === keyboardUp ? prev : { bottom, keyboardUp },
      )
    }
    measure()
    const viewport = window.visualViewport
    viewport?.addEventListener("resize", measure)
    viewport?.addEventListener("scroll", measure)
    window.addEventListener("resize", measure)
    window.addEventListener("scroll", measure, true)
    const poll = window.setInterval(measure, 250)
    return () => {
      viewport?.removeEventListener("resize", measure)
      viewport?.removeEventListener("scroll", measure)
      window.removeEventListener("resize", measure)
      window.removeEventListener("scroll", measure, true)
      window.clearInterval(poll)
    }
  }, [])
  return state
}

/**
 * Tell the page what the keyboard and the bar cover (`INSET_VAR` on the
 * root), so its scroller pads by it and the end of a note can be brought
 * above them; cleared when the bar goes.
 */
function usePageInset(barRef: React.RefObject<HTMLDivElement | null>, bottom: number) {
  useEffect(() => {
    const covered = Math.max(0, window.innerHeight - bottom)
    const bar = barRef.current?.offsetHeight ?? 0
    document.documentElement.style.setProperty(INSET_VAR, `${covered + bar}px`)
  }, [barRef, bottom])
  useEffect(
    () => () => {
      document.documentElement.style.removeProperty(INSET_VAR)
    },
    [],
  )
}

/**
 * The edit bar a touch screen gets above its keyboard while a block is being
 * edited — Notion's shape: a row of actions that scrolls sideways, and a
 * Done pinned at the right that puts the keyboard away. The actions are the
 * ones a virtual keyboard has no keys for: turn into (the block's type,
 * picked from a second row), bold / italic / code around the selection,
 * outdent and indent, move up and down, duplicate, delete, and a picture
 * where images are on. Each runs the same command its key does, in edit
 * mode with the caret, so Indent by bar is Tab by key.
 *
 * Fixed to the bottom of the visual viewport, so it sits on the keyboard
 * whether the keyboard overlays the page (iOS) or shrinks it (Android).
 * Every button cancels its pointer down, so a tap never takes focus from the
 * textarea — which would end the edit and dismiss the keyboard the bar sits
 * on. The keyboard going away ends the edit: on iOS that is a blur, which
 * the row handles; on Android the Back key hides it without one, so the bar
 * watches the viewport grow back and calls `done` itself.
 */
export function MobileEditBar({
  type,
  actions,
}: {
  /** The edited block's type — the Turn into row marks it. */
  type: BlockType
  actions: MobileEditBarActions
}) {
  const { bottom, keyboardUp } = useKeyboard(actions.done)
  const barRef = useRef<HTMLDivElement>(null)
  usePageInset(barRef, bottom)
  const [view, setView] = useState<"main" | "turnInto">("main")
  if (typeof document === "undefined") return null
  return createPortal(
    <div
      ref={barRef}
      role="toolbar"
      aria-label="Editing"
      data-testid="mobile-edit-bar"
      data-keyboard={keyboardUp ? "up" : "down"}
      className="fixed inset-x-0 top-0 z-20 flex items-stretch border-t border-border-secondary bg-bg-overlay will-change-transform print:hidden"
      style={{
        // The bar's bottom edge on the visual viewport's (see `useKeyboard`).
        transform: `translateY(calc(${bottom}px - 100%))`,
        // Under a keyboard the safe area is the keyboard's; without one the
        // bar sits on the home indicator and keeps clear of it.
        paddingBottom: keyboardUp ? 0 : "env(safe-area-inset-bottom)",
      }}
    >
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {view === "turnInto" ? (
          <>
            <BarButton label="Back" onClick={() => setView("main")}>
              <ChevronLeftIcon16 />
            </BarButton>
            <Rule />
            {TYPES.map((def) => (
              <BarButton
                key={def.id}
                label={def.label}
                pressed={canonicalOf(type) === def.id}
                onClick={() => {
                  actions.turnInto(def.id)
                  setView("main")
                }}
                className="px-3 text-sm"
              >
                {def.label}
              </BarButton>
            ))}
          </>
        ) : (
          <>
            <BarButton
              label="Turn into"
              onClick={() => setView("turnInto")}
              className="font-medium"
            >
              Aa
            </BarButton>
            <Rule />
            <BarButton label="Bold" onClick={actions.bold} className="font-bold">
              B
            </BarButton>
            <BarButton label="Italic" onClick={actions.italic} className="font-content italic">
              I
            </BarButton>
            <BarButton label="Code" onClick={actions.code} className="font-mono text-sm">
              {"<>"}
            </BarButton>
            <Rule />
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
            <Rule />
            <BarButton label="Duplicate" onClick={actions.duplicate}>
              <CopyIcon16 />
            </BarButton>
            <BarButton label="Delete" onClick={actions.remove}>
              <TrashIcon16 />
            </BarButton>
            {actions.image ? (
              <BarButton label="Image" onClick={actions.image}>
                <PaperclipIcon16 />
              </BarButton>
            ) : null}
          </>
        )}
      </div>
      <Rule />
      <BarButton label="Done" onClick={actions.done} className="px-4 font-semibold text-text">
        Done
      </BarButton>
    </div>,
    document.body,
  )
}

/** A hairline between groups of buttons. */
function Rule() {
  return <span aria-hidden className="my-3 w-px shrink-0 bg-border-secondary" />
}

/** Keeps focus where it is: the pointer down is cancelled, so the textarea
 * never blurs and the keyboard stays up for the tap that follows. */
const keepFocus = (event: React.SyntheticEvent) => event.preventDefault()

function BarButton({
  label,
  onClick,
  pressed,
  className,
  children,
}: {
  label: string
  onClick: () => void
  /** The row's current choice (the Turn into row's current type). */
  pressed?: boolean
  className?: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      tabIndex={-1}
      onPointerDown={keepFocus}
      onMouseDown={keepFocus}
      onClick={onClick}
      className={cx(
        "flex h-11 min-w-11 shrink-0 cursor-pointer select-none items-center justify-center whitespace-nowrap text-text-secondary active:bg-bg-active",
        pressed && "text-text-selected bg-bg-selected-faint",
        className,
      )}
    >
      {children}
    </button>
  )
}
