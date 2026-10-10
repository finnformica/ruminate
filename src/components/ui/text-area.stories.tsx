import { OBJECT_NOTES } from "../../data/boards"
import { TextArea } from "./text-area"

export default {
  title: "TextArea",
  component: TextArea,
  parameters: {
    layout: "centered",
  },
}

export const Default = {
  args: {
    placeholder: "Notes…",
  },
}

export const Flush = {
  args: {
    variant: "flush",
    defaultValue: OBJECT_NOTES,
  },
}
