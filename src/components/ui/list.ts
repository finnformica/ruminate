import { cva } from "class-variance-authority"

/**
 * The shapes of a list's parts — a row, a heading — as recipes rather than
 * components, because the element is the list's to choose: a menu's row is a
 * Base UI `Menu.Item` (or an anchor, when it is a link), a listbox's is a
 * `<div role="option">`, a heading is a `Menu.GroupLabel` or a plain div. The
 * recipe gives each the same shape and the same answers to the pointer, the
 * keyboard and disablement, which the menus and the listboxes each used to
 * spell out for themselves, differently.
 */

/** One row of a menu or a listbox. */
export const listRow = cva(
  [
    "group flex h-8 cursor-pointer select-none items-center gap-3 rounded px-3 outline-hidden coarse:h-10",
    // Under the keyboard (a Base UI item takes focus) and the pointer.
    "focus:bg-bg-hover focus:outline-hidden active:bg-bg-active data-[popup-open]:bg-bg-hover",
    "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[disabled]:focus:bg-transparent data-[disabled]:active:bg-transparent",
  ],
  {
    variants: {
      /** The highlighted row of a listbox whose keyboard lives elsewhere (the
       * slash menu's in the textarea, the qualifier popover's in the input). */
      active: {
        true: "bg-bg-hover",
        false: "",
      },
    },
    defaultVariants: { active: false },
  },
)

/** A heading over a group of rows: chrome, not content. */
export const listHeading = cva(
  "flex h-8 select-none items-center px-3 text-sm text-text-secondary coarse:h-9",
)
