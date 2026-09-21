import { Notice } from "./notice"
import { Button } from "./ui/button"

export default {
  title: "Notice",
  component: Notice,
  parameters: {
    layout: "centered",
  },
  decorators: [
    (Story: React.ComponentType) => (
      <div className="w-[28rem]">
        <Story />
      </div>
    ),
  ],
}

export const Info = {
  args: {
    variant: "info",
    children: "This note was edited on another device. Reload to see the latest.",
  },
}

export const Warning = {
  args: {
    variant: "warning",
    children: "Storage is nearly full. Notes may stop saving.",
    onDismiss: () => {},
  },
}

export const WithActions = {
  args: {
    variant: "warning",
    children: "Someone else changed this note while you were editing.",
    actions: (
      <Button size="small" variant="primary">
        Reload
      </Button>
    ),
    onDismiss: () => {},
  },
}
