import { Keys } from "./keys"

export default {
  title: "Keys",
  component: Keys,
  parameters: {
    layout: "centered",
  },
}

export const Default = {
  args: {
    keys: ["⌘", "⏎"],
  },
}

/** Keys pressed one after another sit apart. */
export const Chord = {
  args: {
    keys: ["G", "S"],
    chord: true,
  },
}

export const Single = {
  args: {
    keys: ["?"],
  },
}
