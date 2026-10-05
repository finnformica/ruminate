import { DropdownMenu } from "./dropdown-menu"
import { IconButton } from "./icon-button"
import { EditIcon16, ExternalLinkIcon16, MoreIcon16, TrashIcon16 } from "../icons"

export default {
  title: "DropdownMenu",
  component: DropdownMenu,
  parameters: {
    layout: "centered",
  },
}

export const Default = {
  render: () => {
    return (
      <DropdownMenu>
        <DropdownMenu.Trigger
          render={
            <IconButton aria-label="Menu">
              <MoreIcon16 />
            </IconButton>
          }
        />
        <DropdownMenu.Content align="center">
          <DropdownMenu.Item icon={<EditIcon16 />} shortcut={["E"]}>
            Edit
          </DropdownMenu.Item>
          <DropdownMenu.Item icon={<ExternalLinkIcon16 />} href="#">
            Open in GitHub
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item variant="danger" icon={<TrashIcon16 />} shortcut={["⌘", "⌫"]} disabled>
            Delete
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu>
    )
  },
}

/**
 * A menu that branches: each submenu opens flush beside its parent, on the
 * side with room, its first row level with the row that opened it. Rest on
 * a branch to open it; on a touch screen, tap it, and tap again to close.
 */
export const WithSubmenus = {
  render: () => {
    return (
      <DropdownMenu>
        <DropdownMenu.Trigger
          render={
            <IconButton aria-label="Menu">
              <MoreIcon16 />
            </IconButton>
          }
        />
        <DropdownMenu.Content align="center">
          <DropdownMenu.Submenu>
            <DropdownMenu.SubmenuTrigger value="Any">Type</DropdownMenu.SubmenuTrigger>
            <DropdownMenu.Content>
              <DropdownMenu.Item selected closeOnClick={false}>
                Any
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item selected={false} closeOnClick={false}>
                Todo
              </DropdownMenu.Item>
              <DropdownMenu.Item selected={false} closeOnClick={false}>
                Heading
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Submenu>
          <DropdownMenu.Submenu>
            <DropdownMenu.SubmenuTrigger value="Ascending">Sort</DropdownMenu.SubmenuTrigger>
            <DropdownMenu.Content width={200}>
              <DropdownMenu.Item selected>Ascending</DropdownMenu.Item>
              <DropdownMenu.Item selected={false}>Descending</DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Submenu>
          <DropdownMenu.Separator />
          <DropdownMenu.Item icon={<EditIcon16 />}>Edit</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu>
    )
  },
}
