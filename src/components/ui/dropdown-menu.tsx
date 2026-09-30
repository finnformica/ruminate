import { Menu } from "@base-ui/react/menu"
import React from "react"
import { cx } from "../../utils/cx"
import { listHeading, listRow } from "./list"
import { Surface } from "./surface"
import { CheckIcon16, ChevronRightIcon12 } from "../icons"
import { Keys } from "./keys"

type ContentProps = {
  side?: "top" | "bottom" | "left" | "right"
  sideOffset?: number
  align?: "start" | "center" | "end"
  alignOffset?: number
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

function Content({
  side = "bottom",
  sideOffset = 4,
  align = "start",
  alignOffset,
  width = 256,
  children,
  className,
  footer,
  finalFocus,
}: ContentProps) {
  return (
    <Menu.Portal>
      <Menu.Positioner
        className="z-popup"
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
      >
        <Menu.Popup
          render={
            <Surface className="grid place-items-stretch overflow-hidden print:hidden outline-hidden" />
          }
          className={className}
          style={{ width }}
          finalFocus={finalFocus}
        >
          <div className="grid max-h-[45svh] scroll-py-1 overflow-auto p-1">{children}</div>
          {footer ? <div className="border-t border-border-secondary p-1.5">{footer}</div> : null}
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
 * item with a chevron, so a menu that branches reads as one menu.
 */
const Submenu = Menu.SubmenuRoot

type SubmenuTriggerProps = Omit<Menu.SubmenuTrigger.Props, "render"> & {
  icon?: React.ReactNode
  /** What the branch is currently set to, shown after the label. */
  value?: React.ReactNode
}

const SubmenuTrigger = React.forwardRef<HTMLDivElement, SubmenuTriggerProps>(
  ({ className, icon, value, children, ...props }, ref) => (
    <Menu.SubmenuTrigger ref={ref} className={cx(listRow(), className)} {...props}>
      <div className="flex w-0 grow items-center gap-3">
        {icon ? <div className="flex text-text-secondary">{icon}</div> : null}
        <span className="grow truncate">{children}</span>
      </div>
      {value ? (
        <span className="min-w-0 max-w-[55%] shrink truncate text-text-secondary">{value}</span>
      ) : null}
      <ChevronRightIcon12 className="shrink-0 text-text-tertiary" />
    </Menu.SubmenuTrigger>
  ),
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
