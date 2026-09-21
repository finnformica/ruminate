import { SearchField } from "./search-field"

export default {
  title: "SearchField",
  component: SearchField,
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
  args: {
    placeholder: "Search…",
  },
}

/** With something typed, the text keeps clear of the control that clears it. */
export const Trailing = {
  args: {
    placeholder: "Search…",
    defaultValue: "meeting notes",
    trailing: true,
  },
}
