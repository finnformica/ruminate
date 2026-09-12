/**
 * A short haptic tick, where the platform lets a web page give one. Used
 * when a press-and-hold opens a block's menu, so the finger learns the hold
 * took without looking.
 *
 * - **Android** (Chrome, Firefox): the Vibration API. It needs a prior user
 *   interaction on the page — a hold is one — and a short pulse reads as a
 *   tick rather than a buzz.
 * - **iPhone**: Safari has no Vibration API, on the web or in a home-screen
 *   app. What it has, since iOS 17.4, is the switch control (`<input
 *   type="checkbox" switch>`), which plays the system tick when it toggles.
 *   That is an accident of the control, not an interface: a hidden switch is
 *   kept on the page and clicked by script. The day Apple closes it, the
 *   click toggles a hidden box and nothing more.
 * - Anywhere else: nothing, silently.
 *
 * Best effort by design: never assume feedback happened.
 */
export function haptic(): void {
  if (typeof navigator === "undefined" || typeof document === "undefined") return
  if (typeof navigator.vibrate === "function") {
    try {
      if (navigator.vibrate(HAPTIC_MS)) return
    } catch {
      // A browser that exposes the API but refuses the call: fall through.
    }
  }
  const toggle = iosSwitch()
  if (toggle) toggle.click()
}

/** One pulse, short enough to feel like a tap. */
const HAPTIC_MS = 12

let switchEl: HTMLInputElement | null | undefined

/** The hidden switch, made once — only where the control exists (Safari 17.4+
 * exposes `switch` on inputs; other engines do not). */
function iosSwitch(): HTMLInputElement | null {
  if (switchEl !== undefined) return switchEl
  const input = document.createElement("input")
  input.type = "checkbox"
  if (!("switch" in input)) return (switchEl = null)
  input.setAttribute("switch", "")
  input.tabIndex = -1
  input.setAttribute("aria-hidden", "true")
  Object.assign(input.style, {
    position: "fixed",
    width: "1px",
    height: "1px",
    opacity: "0",
    pointerEvents: "none",
    left: "0",
    top: "0",
  })
  document.body.appendChild(input)
  return (switchEl = input)
}
