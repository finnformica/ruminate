import { AsyncButton } from "./async-button"
import { TrashIcon16 } from "../icons"

export default {
  title: "AsyncButton",
  component: AsyncButton,
  parameters: {
    layout: "centered",
  },
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Click it: busy for two seconds, then back. */
export const Default = {
  args: {
    children: "Revoke",
    icon: <TrashIcon16 />,
    onClick: () => wait(2000),
  },
}
