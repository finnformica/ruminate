import { listHeading, listRow } from "./list"
import { Surface } from "./surface"
import { EditIcon16, LinkIcon16, TrashIcon16 } from "../icons"

export default {
  title: "List",
  parameters: {
    layout: "centered",
  },
}

/** The row and heading recipes, on a popup surface as a listbox wears them. */
export const Rows = {
  render: () => (
    <Surface motion={false} className="w-64 p-1" role="listbox" aria-label="Example">
      <div className={listHeading()}>Actions</div>
      <div role="option" aria-selected={false} className={listRow()}>
        <span className="grid h-4 w-4 place-items-center text-text-secondary">
          <EditIcon16 />
        </span>
        <span className="grow truncate">Edit</span>
      </div>
      <div role="option" aria-selected className={listRow({ active: true })}>
        <span className="grid h-4 w-4 place-items-center text-text-secondary">
          <LinkIcon16 />
        </span>
        <span className="grow truncate">Copy link</span>
      </div>
      <div role="option" aria-selected={false} className={listRow()}>
        <span className="grid h-4 w-4 place-items-center text-text-danger">
          <TrashIcon16 />
        </span>
        <span className="grow truncate text-text-danger">Delete</span>
      </div>
    </Surface>
  ),
}
