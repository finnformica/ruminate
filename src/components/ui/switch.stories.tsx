import { Switch } from "./switch"

export default {
  title: "Switch",
  component: Switch,
  parameters: {
    layout: "centered",
  },
}

export const Default = {
  args: {
    disabled: false,
  },
}

export const Checked = {
  args: {
    checked: true,
    disabled: false,
  },
}

export const Disabled = {
  args: {
    checked: true,
    disabled: true,
  },
}
