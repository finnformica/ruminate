import { StoryObj } from "@storybook/react"
import { Details } from "./details"
import { Surface } from "./surface"

export default {
  title: "Details",
  component: Details,
  argTypes: {
    defaultOpen: {
      control: "boolean",
    },
  },
}

export const Default: StoryObj<{ defaultOpen: boolean }> = {
  render: (args) => (
    <Details defaultOpen={args.defaultOpen}>
      <Details.Summary>Details</Details.Summary>
      <Surface tier="card" className="p-4">
        Peekaboo!
      </Surface>
    </Details>
  ),
  args: {
    defaultOpen: true,
  },
}
