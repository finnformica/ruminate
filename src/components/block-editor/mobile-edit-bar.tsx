import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type React from "react"
import { BLOCK_TYPE_DEFS, canonicalOf } from "../../blocks/registry"
import type { BlockType } from "../../blocks/types"
import { cx } from "../../utils/cx"
import {
  ArrowLeftToLineIcon16,
  ArrowRightToLineIcon16,
  ChevronsLeftIcon16,
  ImageIcon16,
  KeyboardDownIcon16,
  LinkIcon16,
  RedoIcon16,
  SwapIcon16,
  TrashIcon16,
  UndoIcon16,
} from "../icons"

/** What the bar can do to the row being edited: the same commands the keys
 * and the block menu run (`src/blocks/commands.ts`), plus `done`. */
export interface MobileEditBarActions {
  turnInto: (type: BlockType) => void
  bold: () => void
  italic: () => void
  strike: () => void
  code: () => void
  link: () => void
  math: () => void
  indent: () => void
  outdent: () => void
  undo: () => void
  redo: () => void
  remove: () => void
  /** Add a picture at this row; absent where images are switched off (the
   * button stays, greyed, so the row never changes shape). */
  image?: () => void
  /** End the edit and put the keyboard away. */
  done: () => void
}

/** What the row can take right now: a button whose command would do nothing
 * is greyed, and Redo shows only while there is something to redo. */
export interface MobileEditBarState {
  type: BlockType
  canIndent: boolean
  canOutdent: boolean
  canUndo: boolean
  canRedo: boolean
}

/** The types a block can be turned into: the registry's, in its order (the
 * block menu's Turn into offers the same), each as its markdown glyph — the
 * same glyphs the query box's suggestions draw beside a type. */
const TYPES = BLOCK_TYPE_DEFS.filter((def) => def.turnInto)
const TYPE_GLYPHS: Record<string, string> = {
  text: "¶",
  h1: "#",
  ul: "-",
  ol: "1.",
  todo: "[ ]",
  quote: ">",
  // The fence, not the single backtick that also opens one: three read as
  // a glyph at this size where one is a speck.
  code: "```",
}

/** Every button is this wide, so the Turn into row's highlight can slide to
 * the active one by index. 38px: eight of them fit a 390pt phone with the
 * bar's insets, its end padding and the keyboard button taken out. */
const BUTTON_WIDTH = 38
/** The bar floats this far above the keyboard's top edge. */
const LIFT = 8

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
    document.documentElement.style.setProperty(INSET_VAR, `${covered + bar + LIFT}px`)
  }, [barRef, bottom])
  useEffect(
    () => () => {
      document.documentElement.style.removeProperty(INSET_VAR)
    },
    [],
  )
}

type View = "main" | "format" | "turnInto"

/**
 * The edit bar a touch screen gets above its keyboard while a block is being
 * edited (docs/mobile.md) — a floating pill in Notion's shape: a row of
 * actions that scrolls sideways, and a keyboard-down button in its own
 * segment at the right that puts the keyboard away. The actions are the
 * ones a virtual keyboard has no keys for. The main row: Aa, which swaps the
 * row for the inline formatting (bold, italic, strikethrough, code, link,
 * maths — each drawn as the markdown renders); Turn into, which swaps it for
 * the block types as their markdown glyphs, a highlight sliding to the
 * current one; outdent and indent, greyed where they would do nothing; undo,
 * with redo beside it only while there is something to redo; a picture,
 * where images are on; and delete. Each runs the same command its key does,
 * in edit mode with the caret, so Indent by bar is Tab by key.
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
  state,
  actions,
}: {
  state: MobileEditBarState
  actions: MobileEditBarActions
}) {
  const { bottom, keyboardUp } = useKeyboard(actions.done)
  const barRef = useRef<HTMLDivElement>(null)
  usePageInset(barRef, bottom)
  const [view, setView] = useState<View>("main")
  const rowRef = useRef<HTMLDivElement>(null)
  const overflows = useOverflowsRight(rowRef, [view, state.canRedo, actions.image !== undefined])
  if (typeof document === "undefined") return null
  const current = canonicalOf(state.type)
  const activeType = Math.max(
    0,
    TYPES.findIndex((def) => def.id === current),
  )
  return createPortal(
    <div
      ref={barRef}
      role="toolbar"
      aria-label="Editing"
      data-testid="mobile-edit-bar"
      data-view={view}
      data-keyboard={keyboardUp ? "up" : "down"}
      // The card's ring and shadow on an opaque surface: the bar sits over
      // the note as much as over the keyboard, and a blurred note showing
      // through would muddle the glyphs.
      // 6px of padding at either end is the pill's, not a button's: the
      // first and last glyphs sit clear of the rounded ends, and the row
      // scrolls under it evenly.
      className="fixed inset-x-3 top-0 z-20 flex h-12 items-stretch overflow-hidden rounded-full bg-bg-overlay px-1.5 shadow-2xl ring-1 ring-[var(--neutral-a3)] will-change-transform dark:ring-inset print:hidden"
      style={{
        // The bar's bottom edge a little above the visual viewport's (see
        // `useKeyboard`); with no keyboard, above the home indicator too.
        transform: `translateY(calc(${bottom}px - 100% - ${LIFT}px - var(--edit-bar-lift)))`,
        ["--edit-bar-lift" as string]: keyboardUp ? "0px" : "env(safe-area-inset-bottom)",
      }}
    >
      <div
        ref={rowRef}
        data-overflows={overflows || undefined}
        className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={{
          // A row longer than the bar runs off under a fade, which says
          // so; only then (`useOverflowsRight`), never over a last button.
          maskImage: overflows
            ? "linear-gradient(90deg, #000 calc(100% - 28px), transparent)"
            : undefined,
        }}
      >
        {view === "format" ? (
          <>
            <BarButton label="Back" onClick={() => setView("main")} className="text-text">
              <ChevronsLeftIcon16 />
            </BarButton>
            <Rule />
            <BarButton
              label="Bold"
              onClick={actions.bold}
              className="font-content text-lg font-bold"
            >
              B
            </BarButton>
            <BarButton
              label="Italic"
              onClick={actions.italic}
              className="font-content text-lg italic"
            >
              I
            </BarButton>
            <BarButton
              label="Strikethrough"
              onClick={actions.strike}
              className="font-content text-lg line-through"
            >
              S
            </BarButton>
            <BarButton label="Code" onClick={actions.code}>
              <code className="rounded-sm border border-border-secondary bg-[var(--color-bg-code-block)] px-1.5 py-px font-mono text-[13px]">
                {"<>"}
              </code>
            </BarButton>
            <BarButton label="Link" onClick={actions.link}>
              <LinkIcon16 />
            </BarButton>
            <BarButton label="Maths" onClick={actions.math} className="font-serif text-lg italic">
              <span aria-hidden>√x</span>
            </BarButton>
          </>
        ) : view === "turnInto" ? (
          <>
            <BarButton label="Back" onClick={() => setView("main")} className="text-text">
              <ChevronsLeftIcon16 />
            </BarButton>
            <Rule />
            <div className="relative flex items-stretch">
              {/* The highlight: one pill that slides to the current type. */}
              <span
                aria-hidden
                data-testid="edit-bar-thumb"
                className="absolute top-2 h-8 rounded-full bg-bg-secondary transition-transform duration-200 ease-[var(--ease-in-out)] motion-reduce:transition-none"
                style={{
                  width: BUTTON_WIDTH,
                  transform: `translateX(${activeType * BUTTON_WIDTH}px)`,
                }}
              />
              {TYPES.map((def) => (
                <BarButton
                  key={def.id}
                  label={def.label}
                  pressed={def.id === current}
                  onClick={() => {
                    actions.turnInto(def.id)
                    setView("main")
                  }}
                  className="relative font-mono text-[15px] whitespace-pre"
                >
                  {/* Backticks hang high in the line; the fence is nudged down to
                      sit on the others' centre. */}
                  <span className={def.id === "code" ? "translate-y-[3px]" : undefined}>
                    {TYPE_GLYPHS[def.id] ?? def.label}
                  </span>
                </BarButton>
              ))}
            </div>
          </>
        ) : (
          <>
            <BarButton
              label="Formatting"
              onClick={() => setView("format")}
              className="text-[15px] text-text"
            >
              Aa
            </BarButton>
            <BarButton label="Turn into" onClick={() => setView("turnInto")}>
              <SwapIcon16 />
            </BarButton>
            <BarButton label="Outdent" onClick={actions.outdent} disabled={!state.canOutdent}>
              <ArrowLeftToLineIcon16 />
            </BarButton>
            <BarButton label="Indent" onClick={actions.indent} disabled={!state.canIndent}>
              <ArrowRightToLineIcon16 />
            </BarButton>
            <BarButton label="Undo" onClick={actions.undo} disabled={!state.canUndo}>
              <UndoIcon16 />
            </BarButton>
            {state.canRedo ? (
              <BarButton label="Redo" onClick={actions.redo}>
                <RedoIcon16 />
              </BarButton>
            ) : null}
            <BarButton label="Image" onClick={actions.image ?? noop} disabled={!actions.image}>
              <ImageIcon16 />
            </BarButton>
            {/* Delete keeps to the far right, away from the rest, as the
                destructive one; the gap closes only when the row scrolls. */}
            <BarButton label="Delete" onClick={actions.remove} className="ml-auto text-text-danger">
              <TrashIcon16 />
            </BarButton>
          </>
        )}
      </div>
      <Rule />
      <BarButton label="Hide keyboard" onClick={actions.done} className="w-12 text-text">
        <KeyboardDownIcon16 />
      </BarButton>
    </div>,
    document.body,
  )
}

/** A divider, where one is needed at all: short, a hairline, and faint —
 * after Back, which is not one of the row's actions, and before the
 * keyboard button, which is not part of the row. */
function Rule() {
  return <span aria-hidden className="h-4 w-px shrink-0 self-center bg-[var(--neutral-a4)]" />
}

/** Keeps focus where it is: the pointer down is cancelled, so the textarea
 * never blurs and the keyboard stays up for the tap that follows. */
const keepFocus = (event: React.SyntheticEvent) => event.preventDefault()
const noop = () => {}

/**
 * Whether a row that scrolls sideways has more past its right edge — when
 * the fade that says so is drawn. Never while everything fits, or once the
 * row is scrolled to its end: a fade over the last button would only dim it.
 */
function useOverflowsRight(ref: React.RefObject<HTMLDivElement | null>, deps: unknown[]) {
  const [overflows, setOverflows] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setOverflows(el.scrollWidth - el.clientWidth - el.scrollLeft > 1)
    measure()
    el.addEventListener("scroll", measure, { passive: true })
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null
    observer?.observe(el)
    return () => {
      el.removeEventListener("scroll", measure)
      observer?.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, ...deps])
  return overflows
}

function BarButton({
  label,
  onClick,
  pressed,
  disabled,
  className,
  children,
}: {
  label: string
  onClick: () => void
  /** The row's current choice (the Turn into row's current type). */
  pressed?: boolean
  /** Would do nothing right now: greyed, and inert, as its key would be. */
  disabled?: boolean
  className?: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      aria-disabled={disabled || undefined}
      tabIndex={-1}
      onPointerDown={keepFocus}
      onMouseDown={keepFocus}
      onClick={disabled ? undefined : onClick}
      className={cx(
        "flex h-12 w-[38px] shrink-0 cursor-pointer select-none items-center justify-center text-text-secondary",
        disabled ? "cursor-default text-text-tertiary opacity-50" : "active:text-text",
        pressed && "text-text",
        className,
      )}
    >
      {children}
    </button>
  )
}
