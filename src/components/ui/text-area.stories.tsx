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
    placeholder: "What the model is told",
  },
}

export const Flush = {
  args: {
    variant: "flush",
    defaultValue:
      "The thing the picture is of, such as furniture, lighting, cutlery, plants or decoration",
  },
}
