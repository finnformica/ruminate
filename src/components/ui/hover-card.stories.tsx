import { HoverCard } from "./hover-card"

export default {
  title: "HoverCard",
  parameters: {
    layout: "centered",
  },
}

const card = (
  <div className="flex w-64 flex-col gap-1 p-3">
    <div className="font-bold">Meeting notes</div>
    <div className="text-sm text-text-secondary">Edited yesterday · 12 blocks</div>
  </div>
)

/** Hover the link and wait a moment. */
export const Default = {
  render: () => (
    <HoverCard.Provider>
      <HoverCard.Trigger
        // eslint-disable-next-line jsx-a11y/anchor-has-content -- content is provided via children
        render={<a href="https://example.com/notes/meeting-notes" className="link" />}
        payload={{ content: card }}
      >
        Meeting notes
      </HoverCard.Trigger>
    </HoverCard.Provider>
  ),
}

/** Held open, for the eye and the screenshot: a popup surface hanging off its anchor. */
export const Open = {
  render: () => (
    <div className="p-12 pb-40">
      <HoverCard.Provider open>
        <HoverCard.Trigger
          // eslint-disable-next-line jsx-a11y/anchor-has-content -- content is provided via children
          render={<a href="https://example.com/notes/meeting-notes" className="link" />}
          payload={{ content: card }}
        >
          Meeting notes
        </HoverCard.Trigger>
      </HoverCard.Provider>
    </div>
  ),
}
