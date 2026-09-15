/**
 * Whether a `blur` is the window itself losing focus — a switch to another
 * browser tab or app, a click on the address bar, devtools opening — rather
 * than focus moving somewhere else in the page.
 *
 * The two look alike to the field (both fire `blur`), but they mean different
 * things. Focus moving within the page is the user leaving the field. The
 * window going away is not: the browser keeps the field as the active element
 * and hands focus straight back to it when the window returns, caret and all.
 * A field that ends its edit on blur must therefore let this one pass, or a
 * glance at another tab throws the user out of the block they were typing in.
 *
 * `relatedTarget` names the element focus moved to, when it is one. A click on
 * blank page leaves it null but the document keeps focus; only a window-level
 * blur has both `relatedTarget` null and `document.hasFocus()` false.
 */
export function blurLeavesWindow(relatedTarget: EventTarget | null): boolean {
  return relatedTarget === null && !document.hasFocus()
}
