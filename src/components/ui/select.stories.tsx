import { useState } from "react"
import { Select } from "./select"

export default {
  title: "Select",
  component: Select,
  parameters: {
    layout: "centered",
  },
}

const OPTIONS = ["19:30", "19:45", "20:00", "20:15", "20:30"].map((time) => ({
  value: time,
  label: time,
}))

function Example({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = useState("20:00")
  return (
    <Select
      aria-label="Time"
      className="w-32"
      value={value}
      onValueChange={setValue}
      options={OPTIONS}
      disabled={disabled}
    />
  )
}

export const Default = { render: () => <Example /> }

export const Disabled = { render: () => <Example disabled /> }
