import { Button } from "./button"
import { GitHubIcon16 } from "../icons"

export default {
  title: "Button",
  component: Button,
  parameters: {
    layout: "centered",
  },
}

export const Primary = {
  args: {
    children: "Button",
    variant: "primary",
    size: "medium",
  },
}

export const Secondary = {
  args: {
    children: "Button",
    variant: "secondary",
    size: "medium",
  },
}

export const WithKeyboardShortcut = {
  args: {
    children: "Save",
    shortcut: ["⌘", "⏎"],
    size: "medium",
  },
}

export const Disabled = {
  args: {
    children: "Button",
    disabled: true,
    size: "medium",
  },
}

export const Small = {
  args: {
    children: "Button",
    variant: "secondary",
    size: "small",
  },
}

export const WithIcon = {
  args: {
    children: "Sign in with GitHub",
    icon: <GitHubIcon16 />,
    variant: "primary",
    size: "medium",
  },
}

export const Loading = {
  args: {
    children: "Sign in with GitHub",
    icon: <GitHubIcon16 />,
    loading: true,
    variant: "primary",
    size: "medium",
  },
}
