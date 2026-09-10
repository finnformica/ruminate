import { useEffect, useRef } from "react"
import type { CSSProperties } from "react"
import { slashGroupOf, type SlashItem } from "../../blocks/slash-menu"
import type { BlockType } from "../../blocks/types"
import { cx } from "../../utils/cx"
import { CalendarDateIcon16 } from "../icons"

/** Width of the popup (px); the anchor is clamped so it never overflows. */
export const SLASH_MENU_WIDTH = 256

/** The glyph in a "turn into" row's icon slot — the marker the block will
 * carry, drawn as chrome the way the editor draws real markers. */
function blockGlyph(type: BlockType): string {
  switch (type) {
    case "ul":
      return "•"
    case "ol":
      return "1."
    case "todo":
    case "done":
      return "☐"
    case "h1":
    case "h2":
    case "h3":
      return "#"
    case "quote":
      return "❝"
    default:
      return "Aa"
  }
}

/**
 * The slash menu popup: the rows for the current `/phrase`, grouped under
 * "Dates" and "Turn into", with one highlighted. Pure presentation — the
 * block item owns the state (which row is active, what a pick does) and
 * positions the popup under the `/` via `style`.
 *
 * The textarea keeps focus throughout: mousedown on the popup is cancelled
 * so a click never blurs the editor (which would end editing and unmount
 * the menu before the click lands).
 */
export function SlashMenu({
  items,
  activeIndex,
  style,
  onHover,
  onPick,
}: {
  items: SlashItem[]
  activeIndex: number
  style?: CSSProperties
  onHover: (index: number) => void
  onPick: (item: SlashItem) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)

  // Keep the highlighted row visible as the arrows walk past the popup's
  // scrollable height.
  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    active?.scrollIntoView?.({ block: "nearest" })
  }, [activeIndex, items])

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Slash menu"
      data-testid="slash-menu"
      // Focus stays in the textarea (the keys are handled there); the popup
      // is reachable by pointer and screen readers, never by Tab.
      tabIndex={-1}
      style={{ width: SLASH_MENU_WIDTH, ...style }}
      className="card-2 absolute z-20 max-h-[45svh] overflow-auto rounded-lg p-1 font-sans text-base font-normal leading-normal tracking-normal text-text no-underline"
      onMouseDown={(event) => event.preventDefault()}
    >
      {items.map((item, index) => {
        const group = slashGroupOf(item)
        const heading = index === 0 || slashGroupOf(items[index - 1]) !== group
        const active = index === activeIndex
        return (
          <div key={item.id} className={cx(heading && index > 0 && "mt-1")}>
            {heading ? (
              // Group labels are chrome, not content — faint, like the ⌘K menu's.
              <div className="flex h-7 items-center px-2 text-sm text-text-tertiary">{group}</div>
            ) : null}
            {/* Keyboard handling lives on the textarea (arrows / Enter / Esc);
                this row only needs the pointer. */}
            {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events */}
            <div
              role="option"
              aria-selected={active}
              tabIndex={-1}
              data-slash-item={item.id}
              className={cx(
                "flex h-8 cursor-pointer select-none items-center gap-3 rounded px-2",
                active && "bg-bg-hover",
              )}
              onMouseEnter={() => onHover(index)}
              onClick={() => onPick(item)}
            >
              <span className="grid h-4 w-4 shrink-0 place-items-center text-sm text-text-secondary">
                {item.kind === "date" ? (
                  <CalendarDateIcon16 date={Number(item.date.slice(-2))} />
                ) : (
                  <span aria-hidden>{blockGlyph(item.type)}</span>
                )}
              </span>
              <span className="grow truncate">{item.label}</span>
              {item.kind === "date" ? (
                <span className="shrink-0 text-sm text-text-secondary">{item.detail}</span>
              ) : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}
