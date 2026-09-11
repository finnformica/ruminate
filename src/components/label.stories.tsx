import { Label } from "./label"
import { DotIcon8, TagIcon12 } from "./icons"

export default {
  title: "Label",
  component: Label,
  parameters: {
    layout: "centered",
  },
}

export const Default = {
  args: {
    children: "Label",
  },
}

export const WithIcon = {
  args: {
    icon: <TagIcon12 />,
    children: "book",
  },
}

export const WithSmallIcon = {
  args: {
    icon: <DotIcon8 className="text-text-pending" />,
    children: "Unsaved",
  },
}
