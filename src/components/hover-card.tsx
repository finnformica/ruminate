import { PreviewCard } from "@base-ui/react/preview-card"
import { Surface } from "./ui/surface"

type Payload = {
  content: React.ReactNode
  popupClassName?: string
  side?: "top" | "bottom" | "left" | "right"
  sideOffset?: number
  align?: "start" | "center" | "end"
  alignOffset?: number
  anchor?: Element | null
  transformOrigin?: string
}

function Provider({
  children,
  container,
}: {
  children: React.ReactNode
  container?: HTMLElement | null
}) {
  return (
    <PreviewCard.Root<Payload>>
      {({ payload }) => (
        <>
          {children}
          <PreviewCard.Portal container={container}>
            <PreviewCard.Positioner
              className="z-popup"
              side={payload?.side ?? "bottom"}
              sideOffset={payload?.sideOffset ?? 4}
              align={payload?.align ?? "start"}
              alignOffset={payload?.alignOffset}
              anchor={payload?.anchor}
            >
              <PreviewCard.Popup
                render={<Surface className="print:hidden no-hover:hidden" />}
                className={payload?.popupClassName}
                // The origin is the caller's: a card hanging off a word in a
                // line points at the word, not at the line.
                style={{
                  transformOrigin: payload?.transformOrigin ?? "var(--transform-origin)",
                }}
              >
                {payload?.content}
              </PreviewCard.Popup>
            </PreviewCard.Positioner>
          </PreviewCard.Portal>
        </>
      )}
    </PreviewCard.Root>
  )
}

function Trigger({
  render,
  payload,
  children,
}: {
  render: React.ReactElement
  payload: Payload
  children: React.ReactNode
}) {
  return (
    <PreviewCard.Trigger<Payload> render={render} payload={payload}>
      {children}
    </PreviewCard.Trigger>
  )
}

export const HoverCard = Object.assign({}, { Provider, Trigger })
