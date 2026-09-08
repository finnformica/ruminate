/**
 * Textarea caret geometry, so arrow keys can tell whether the caret sits on the
 * first/last *visual* line of a block that has wrapped across several lines.
 * A textarea exposes no such API, so we mirror its text into a hidden div with
 * identical typography and measure where the caret would land.
 */

const MIRROR_PROPS = [
  "boxSizing",
  "width",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "fontStyle",
  "fontVariant",
  "fontWeight",
  "fontStretch",
  "fontSize",
  "lineHeight",
  "fontFamily",
  "textAlign",
  "textIndent",
  "letterSpacing",
  "wordSpacing",
  "tabSize",
  "whiteSpace",
  "wordBreak",
  "overflowWrap",
] as const

/** Where the caret for `position` sits within `textarea`, in px from its
 * top-left (padding included), measured in the mirror. */
function measureCaret(
  textarea: HTMLTextAreaElement,
  position: number,
): { top: number; left: number } {
  const doc = textarea.ownerDocument
  const div = doc.createElement("div")
  const computed = getComputedStyle(textarea)
  const style = div.style
  style.position = "absolute"
  style.visibility = "hidden"
  style.whiteSpace = "pre-wrap"
  style.overflowWrap = "break-word"
  style.height = "auto"
  const writable = style as unknown as Record<string, string>
  const source = computed as unknown as Record<string, string>
  for (const prop of MIRROR_PROPS) writable[prop] = source[prop]

  div.textContent = textarea.value.slice(0, position)
  const marker = doc.createElement("span")
  // A non-empty span so it has a box even at the end of the text.
  marker.textContent = textarea.value.slice(position) || "."
  div.appendChild(marker)

  doc.body.appendChild(div)
  const top = marker.offsetTop
  const left = marker.offsetLeft
  doc.body.removeChild(div)
  return { top, left }
}

/** The top offset (px) of the caret line for `position` within `textarea`. */
function caretTop(textarea: HTMLTextAreaElement, position: number): number {
  return measureCaret(textarea, position).top
}

/**
 * The caret's box for `position`, relative to the textarea's top-left — where
 * a popover anchored to a character (the slash menu's `/`) should hang from.
 */
export function caretCoordinates(
  textarea: HTMLTextAreaElement,
  position: number,
): { top: number; left: number; height: number } {
  const { top, left } = measureCaret(textarea, position)
  const height = parseFloat(getComputedStyle(textarea).lineHeight) || 16
  return { top, left, height }
}

/**
 * Whether the caret is on the first / last visual line of the textarea — used
 * to decide when ArrowUp/ArrowDown should leave the block versus move a line
 * within it.
 */
export function caretLineFlags(textarea: HTMLTextAreaElement): {
  atFirst: boolean
  atLast: boolean
} {
  const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 16
  const paddingTop = parseFloat(getComputedStyle(textarea).paddingTop) || 0
  const caret = caretTop(textarea, textarea.selectionStart)
  const end = caretTop(textarea, textarea.value.length)
  return {
    atFirst: caret - paddingTop < lineHeight,
    atLast: end - caret < lineHeight,
  }
}
