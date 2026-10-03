import { Menu } from "@base-ui/react/menu"
import React from "react"
import { useCoarsePointer } from "../../hooks/coarse-pointer"
import { cx } from "../../utils/cx"
import { InModalContext } from "./layer"
import { listHeading, listRow } from "./list"
import { Surface } from "./surface"
import { CheckIcon16, ChevronRightIcon12 } from "../icons"
import { Keys } from "./keys"

/** Whether the content being drawn is a submenu's (`Submenu` says so). */
const NestedContext = React.createContext(false)

/** The popup's own padding (`p-1`), which a submenu's placement allows for. */
const POPUP_PADDING = 4

/**
 * The submenus a menu holds, each as the one call that closes it — so a
 * press on the menu itself (its padding, a separator, a heading) can take
 * an open submenu down without taking the menu with it. Provided by
 * `Content`, joined by `Submenu`.
 */
type ChildMenus = { add: (close: () => void) => () => void }
const ChildMenusContext = React.createContext<ChildMenus | null>(null)

function useChildMenus(): { context: ChildMenus; closeAll: () => void } {
  const closers = React.useRef(new Set<() => void>())
  const context = React.useMemo<ChildMenus>(
    () => ({
      add: (close) => {
        closers.current.add(close)
        return () => {
          closers.current.delete(close)
        }
      },
    }),
    [],
  )
  const closeAll = React.useCallback(() => {
    for (const close of closers.current) close()
  }, [])
  return { context, closeAll }
}

/**
 * How a submenu avoids the edge of the screen: it flips to the other side
 * of its parent when its own has no room, and when neither has, takes the
 * side with more rather than dropping beneath its trigger — which would
 * land it on top of the parent, hiding the rows it was opened from.
 */
const SUBMENU_COLLISION: Menu.Positioner.Props["collisionAvoidance"] = {
  side: "flip",
  align: "shift",
  fallbackAxisSide: "none",
}

type ContentProps = {
  side?: "top" | "bottom" | "left" | "right" | "inline-start" | "inline-end"
  sideOffset?: number
  align?: "start" | "center" | "end"
  alignOffset?: number
  /** A fixed width, inline. Left out, the menu is `w-64`, and a class on
   * `className` (`max-sm:w-44`) may size it by the screen. */
  width?: number | string
  children?: React.ReactNode
  className?: string
  /**
   * A strip pinned beneath the items, outside the scroller — for an action
   * about the menu as a whole rather than one of its rows (the note
   * header's **Update to default** / **Reset to default**). Left out, the
   * menu is its items and nothing else.
   */
  footer?: React.ReactNode
  /**
   * Where the keyboard goes when the menu closes. Left out, Base UI hands
   * it back to the trigger. A menu that acts on something else — the
   * selection bar's, on the editor's selection — names that instead, so
   * the keys work there again the moment an item has run.
   */
  finalFocus?: Menu.Popup.Props["finalFocus"]
}

/**
 * A menu's popup. A submenu's (inside `Submenu`) sits flush against its
 * parent, beside the row that opened it — on the side with room, flipping
 * to the other when its own has none — and never wider than that room, so
 * on a phone the two menus share the width rather than one covering the
 * other. Its first row lines up with its trigger (the popup's own padding
 * is taken off the alignment).
 */
function Content({
  side,
  sideOffset,
  align = "start",
  alignOffset,
  width,
  children,
  className,
  footer,
  finalFocus,
}: ContentProps) {
  // A menu opened from inside a dialog floats in the dialog's layer, or it
  // would open behind the window its trigger is in.
  const inModal = React.useContext(InModalContext)
  const nested = React.useContext(NestedContext)
  const children_ = useChildMenus()
  // A press on the menu itself — not on a row, which answers for itself
  // (a submenu's trigger toggles it; an item runs), and not in a submenu,
  // whose events bubble up through React's tree but not the DOM's — closes
  // whatever submenu it holds open, and leaves the menu standing. With a
  // mouse the hover does this on its own; a finger has no hover, so the
  // tap must.
  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    const target = event.target as Element
    if (target.closest('[role="menu"]') !== event.currentTarget) return
    if (target.closest('[role="menuitem"]')) return
    children_.closeAll()
  }
  return (
    <Menu.Portal>
      <Menu.Positioner
        className={inModal ? "z-modal" : "z-popup"}
        // Left to Base UI, a submenu opens at its parent's inline end. The
        // parent's padding is added to the side, so the two surfaces meet
        // edge to edge, and taken off the alignment, so the submenu's first
        // row lines up with its trigger.
        side={side ?? (nested ? undefined : "bottom")}
        sideOffset={sideOffset ?? (nested ? POPUP_PADDING : 4)}
        align={align}
        alignOffset={alignOffset ?? (nested ? -POPUP_PADDING : undefined)}
        collisionAvoidance={nested ? SUBMENU_COLLISION : undefined}
      >
        <Menu.Popup
          render={
            <Surface className="grid w-64 place-items-stretch overflow-hidden print:hidden outline-hidden" />
          }
          className={className}
          style={{
            width,
            maxWidth: nested ? "var(--available-width)" : undefined,
          }}
          finalFocus={finalFocus}
          onPointerDown={onPointerDown}
        >
          <ChildMenusContext.Provider value={children_.context}>
            <div className="grid max-h-[45svh] scroll-py-1 overflow-auto p-1">{children}</div>
            {footer ? <div className="border-t border-border-secondary p-1.5">{footer}</div> : null}
          </ChildMenusContext.Provider>
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  )
}

function Trigger({ render, children, ...props }: Menu.Trigger.Props) {
  return (
    <Menu.Trigger render={render} {...props}>
      {children}
    </Menu.Trigger>
  )
}

type ItemProps = Omit<Menu.Item.Props, "render"> & {
  icon?: React.ReactNode
  shortcut?: string[]
  trailingVisual?: React.ReactNode
  variant?: "default" | "danger"
  selected?: boolean
  href?: string
  target?: string
  rel?: string
}

const Item = React.forwardRef<HTMLDivElement, ItemProps>(
  (
    {
      className,
      icon,
      shortcut,
      trailingVisual,
      variant,
      selected,
      href,
      target,
      rel,
      children,
      ...props
    },
    ref,
  ) => {
    const content = (
      <>
        <div
          className={cx(
            "flex w-0 grow items-center gap-3",
            variant === "danger" && "text-text-danger",
          )}
        >
          {icon ? (
            <div
              className={cx("flex text-text-secondary", variant === "danger" && "text-text-danger")}
            >
              {icon}
            </div>
          ) : null}
          <span className="grow truncate">{children}</span>
        </div>
        {trailingVisual}
        {shortcut ? (
          <div className="flex coarse:hidden">
            <Keys keys={shortcut} />
          </div>
        ) : null}
        {selected !== undefined ? selected ? <CheckIcon16 /> : <div className="h-4 w-4" /> : null}
      </>
    )

    return (
      <Menu.Item
        ref={ref}
        className={cx(listRow(), className)}
        // eslint-disable-next-line jsx-a11y/anchor-has-content -- content is provided via children
        render={href ? <a href={href} target={target} rel={rel} /> : undefined}
        {...props}
      >
        {content}
      </Menu.Item>
    )
  },
)

/**
 * A nested menu: `<DropdownMenu.Submenu>` wraps a `SubmenuTrigger` (the row
 * that opens it) and a `Content` (its items). The trigger is an ordinary
 * item with a chevron, so a menu that branches reads as one menu, and the
 * content opens beside it (see `Content`).
 */
function Submenu({ actionsRef, ...props }: Menu.SubmenuRoot.Props) {
  const ownActions = React.useRef<Menu.Root.Actions | null>(null)
  const actions = actionsRef ?? ownActions
  // Known to the menu it sits in, so a press on that menu can close it.
  const parent = React.useContext(ChildMenusContext)
  React.useEffect(() => parent?.add(() => actions.current?.close()), [parent, actions])
  return (
    <NestedContext.Provider value>
      <Menu.SubmenuRoot actionsRef={actions} {...props} />
    </NestedContext.Provider>
  )
}

type SubmenuTriggerProps = Omit<Menu.SubmenuTrigger.Props, "render"> & {
  icon?: React.ReactNode
  /** What the branch is currently set to, shown after the label. */
  value?: React.ReactNode
}

/**
 * The row that opens a submenu. With a mouse, resting on it opens the
 * submenu and moving off it closes it, as a menu bar's do, and a click is
 * the hover's (Base UI ignores it). A finger has no hover, so there a tap
 * opens the submenu and a second tap closes it — `openOnHover` is off for
 * a coarse pointer, which is what turns Base UI's click into a toggle.
 */
const SubmenuTrigger = React.forwardRef<HTMLDivElement, SubmenuTriggerProps>(
  ({ className, icon, value, children, openOnHover, ...props }, ref) => {
    const coarse = useCoarsePointer()
    return (
      <Menu.SubmenuTrigger
        ref={ref}
        className={cx(listRow(), className)}
        openOnHover={openOnHover ?? !coarse}
        {...props}
      >
        <div className="flex w-0 grow items-center gap-3">
          {icon ? <div className="flex text-text-secondary">{icon}</div> : null}
          <span className="grow truncate">{children}</span>
        </div>
        {value ? (
          <span className="min-w-0 max-w-[55%] shrink truncate text-text-secondary">{value}</span>
        ) : null}
        <ChevronRightIcon12 className="shrink-0 text-text-tertiary" />
      </Menu.SubmenuTrigger>
    )
  },
)

function Separator() {
  return <Menu.Separator className="mx-3 my-1 h-px bg-border-secondary" />
}

const Group = Menu.Group

const GroupLabel = React.forwardRef<HTMLDivElement, Menu.GroupLabel.Props>(
  ({ className, ...props }, ref) => (
    <Menu.GroupLabel ref={ref} className={cx(listHeading(), className)} {...props} />
  ),
)

export const DropdownMenu = Object.assign(Menu.Root, {
  Trigger,
  Content,
  Item,
  Separator,
  Group,
  GroupLabel,
  Submenu,
  SubmenuTrigger,
})
