import { StoryObj } from "@storybook/react"
import { useState } from "react"
import { QueryBox } from "./query-box"

/**
 * The query box on its own: type `type:`, `in:`, `has:`, `no:`, `sort:` or
 * `date:` and the qualifier popover hangs beside the token; an `in:` shows
 * as a pill beneath. The page dress, or the palette's bare line.
 */
function Harness({
  initial = "",
  variant = "page",
}: {
  initial?: string
  variant?: "page" | "palette"
}) {
  const [value, setValue] = useState(initial)
  return (
    <div style={{ maxWidth: 640, padding: 24 }}>
      <QueryBox
        variant={variant}
        value={value}
        onChange={setValue}
        placeholder="Search notes…"
        shortcut={variant === "page" ? ["/"] : undefined}
      />
    </div>
  )
}

export default {
  title: "QueryBox",
  component: Harness,
}

type Story = StoryObj<typeof Harness>

export const Page: Story = {
  args: { initial: "" },
}

/** A scope already in the text: its pill beneath the box. */
export const Scoped: Story = {
  args: { initial: "in:n1 milk" },
}

export const Palette: Story = {
  args: { initial: "", variant: "palette" },
}
