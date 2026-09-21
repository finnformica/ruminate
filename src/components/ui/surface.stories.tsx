import { Surface } from "./surface"

export default {
  title: "Surface",
  component: Surface,
  parameters: {
    layout: "centered",
  },
}

const Sample = () => (
  <div className="flex flex-col gap-1 p-4">
    <div className="font-bold">A raised surface</div>
    <div className="text-sm text-text-secondary">Edge, fill, shadow and radius from its tier.</div>
  </div>
)

/** The three tiers side by side: on the page, over it, over everything. */
export const Tiers = {
  render: () => (
    <div className="grid grid-cols-3 gap-6 p-8">
      <Surface tier="card">
        <Sample />
      </Surface>
      <Surface tier="popup" motion={false}>
        <Sample />
      </Surface>
      <Surface tier="modal" motion={false}>
        <Sample />
      </Surface>
    </div>
  ),
}

export const Card = {
  args: { tier: "card", children: <Sample /> },
}

export const Popup = {
  args: { tier: "popup", children: <Sample /> },
}

export const Modal = {
  args: { tier: "modal", children: <Sample /> },
}
