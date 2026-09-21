import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip"
import { Surface } from "./ui/surface"

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
          // The tooltip layer, above the popups and the modals alike: a
          // tooltip belongs to the control under the pointer, wherever it is.
          render={<Surface layer="tooltip" className="px-2.5 py-2 leading-none text-text" />}
          className={className}
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
