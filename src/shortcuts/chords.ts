/**
 * The `g` chord state machine behind the app's navigation vocabulary
 * (`g d` → today's daily note, `g n` → notes, …). Pressing `g` outside any
 * typing context arms a short window; the next key either fires its action or
 * disarms. Pure and timer-based only through `setTimeout`, so tests drive it
 * with fake timers.
 */

/** The slice of a keydown event the machine looks at. */
export interface ChordKey {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  /** True when the event targets an input/textarea/select/contenteditable. */
  isTyping: boolean
  /** True when something upstream (e.g. the block editor) consumed the key. */
  defaultPrevented: boolean
}

export class GChordMachine {
  private timer: ReturnType<typeof setTimeout> | null = null
  private armed = false

  constructor(
    /** Second-key → action, e.g. `{ d: goToToday }`. */
    private actions: Record<string, () => void>,
    private timeoutMs = 1500,
  ) {}

  get isArmed(): boolean {
    return this.armed
  }

  /** Feed a keydown. Returns true when consumed (caller should preventDefault). */
  handleKey(event: ChordKey): boolean {
    const blocked =
      event.isTyping ||
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.shiftKey
    if (this.armed) {
      this.disarm()
      if (blocked) return false
      // A second g restarts the window rather than dead-ending.
      if (event.key === "g") {
        this.arm()
        return true
      }
      const action = this.actions[event.key]
      if (!action) return false
      action()
      return true
    }
    if (event.key !== "g" || blocked) return false
    this.arm()
    return true
  }

  disarm(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.armed = false
  }

  private arm(): void {
    this.armed = true
    this.timer = setTimeout(() => this.disarm(), this.timeoutMs)
  }
}
