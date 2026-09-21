import { SearchInput } from "./search-input"

export default {
  title: "SearchInput",
  component: SearchInput,
  parameters: {
    layout: "centered",
  },
  decorators: [
    (Story: React.ComponentType) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
}

export const Default = {
  args: {},
}

/** The shortcut hint, shown while the box is empty. */
export const WithShortcut = {
  args: {
    shortcut: ["/"],
  },
}

/** With a value, the hint gives way to the control that clears it. */
export const WithValue = {
  args: {
    value: "meeting notes",
  },
}
