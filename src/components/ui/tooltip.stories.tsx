import { Tooltip } from "./tooltip"
import { IconButton } from "./icon-button"
import { Keys } from "./keys"
import { SearchIcon16 } from "../icons"

export default {
  title: "Tooltip",
  component: Tooltip,
  parameters: {
    layout: "centered",
  },
}

/** Hover or focus the control. */
export const Default = {
  render: () => (
    <Tooltip>
      <Tooltip.Trigger render={<IconButton aria-label="Search" disableTooltip />}>
        <SearchIcon16 />
      </Tooltip.Trigger>
      <Tooltip.Content>Search</Tooltip.Content>
    </Tooltip>
  ),
}

/** Held open, for the eye and the screenshot: the popup surface, the tooltip layer. */
export const Open = {
  render: () => (
    <div className="p-12">
      <Tooltip open>
        <Tooltip.Trigger render={<IconButton aria-label="Search" disableTooltip />}>
          <SearchIcon16 />
        </Tooltip.Trigger>
        <Tooltip.Content>
          <div className="flex items-center gap-1.5">
            <span>Search</span>
            <div className="flex text-text-secondary">
              <Keys keys={["⌘", "K"]} />
            </div>
          </div>
        </Tooltip.Content>
      </Tooltip>
    </div>
  ),
}
