import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip"
import { cx } from "../utils/cx"
import { POPUP_MOTION } from "./popup-motion"

type ContentProps = {
  side?: "top" | "bottom" | "left" | "right"
  sideOffset?: number
  align?: "start" | "center" | "end"
  alignOffset?: number
  children?: React.ReactNode
  className?: string
}

function Content({
  side = "top",
  sideOffset = 4,
  align,
  alignOffset,
  children,
  className,
}: ContentProps) {
  return (
    <BaseTooltip.Portal>
      <BaseTooltip.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
      >
        <BaseTooltip.Popup
          className={cx(
            "card-2 z-20 px-2.5 py-2 leading-none text-text",
            POPUP_MOTION,
            "origin-(--transform-origin)",
            className,
          )}
        >
          {children}
        </BaseTooltip.Popup>
      </BaseTooltip.Positioner>
    </BaseTooltip.Portal>
  )
}

function Trigger({ render, children, ...props }: BaseTooltip.Trigger.Props) {
  return (
    <BaseTooltip.Trigger render={render} {...props}>
      {children}
    </BaseTooltip.Trigger>
  )
}

export const Tooltip = Object.assign(BaseTooltip.Root, {
  Trigger,
  Content,
})
