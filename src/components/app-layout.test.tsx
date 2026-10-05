// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The layout under test is the panel group: the page, the separator and the
// help panel. Everything it hangs inside that group is stood in for.
vi.mock("./sidebar", () => ({ Sidebar: () => <div data-testid="sidebar" /> }))
vi.mock("./nav-bar", () => ({ NavBar: () => null }))
vi.mock("./sign-in-banner", () => ({ SignInBanner: () => null }))
vi.mock("./whats-new-popover", () => ({ WhatsNewPopover: () => null }))
vi.mock("./help-panel", () => ({
  HelpSidebar: ({ open }: { open: boolean }) => <div data-testid="help-sidebar" data-open={open} />,
  HelpDrawer: () => <div data-testid="help-drawer" />,
}))
vi.mock("../hooks/app-update", () => ({
  useRegisterAppUpdate: () => {},
  useApplyUpdateShortcut: () => {},
}))

import { isHelpPanelOpenAtom } from "../global-state"
import { AppLayout } from "./app-layout"

/**
 * jsdom has neither `matchMedia` nor `ResizeObserver`, and lays nothing out.
 * The one media query the layout asks about is the wide viewport, answered
 * by `wide` and re-answered to every listener when it changes — a window
 * being widened or narrowed across the breakpoint. The panels are given the
 * widths their layout asks for, so that the group measures as a thousand
 * pixels across and a percentage means something, and are kept in document
 * order.
 */
let wide = false
const listeners = new Set<() => void>()

function setViewport(isWide: boolean) {
  wide = isWide
  act(() => {
    listeners.forEach((listener) => listener())
  })
}

const elementSizes = ["offsetWidth", "offsetLeft"].map(
  (name) =>
    [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as [
      string,
      PropertyDescriptor | undefined,
    ],
)

beforeEach(() => {
  wide = false
  listeners.clear()
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      if (!this.hasAttribute("data-panel")) return 0
      const share = parseFloat(this.style.flexGrow)
      return Number.isFinite(share) ? share * 10 : 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, "offsetLeft", {
    configurable: true,
    get(this: HTMLElement) {
      return [...document.querySelectorAll("[data-panel]")].indexOf(this)
    },
  })
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return wide
    },
    media: query,
    onchange: null,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    addListener: (listener: () => void) => listeners.add(listener),
    removeListener: (listener: () => void) => listeners.delete(listener),
    dispatchEvent: () => false,
  }))
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  for (const [name, descriptor] of elementSizes) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
  }
})

/** A panel's share of the group's width: the flex-grow the layout gave it. */
function panelShare(id: string): number {
  const panel = document.getElementById(id)
  if (!panel) throw new Error(`no panel ${id}`)
  return parseFloat(panel.style.flexGrow)
}

function renderLayout(helpOpen: boolean) {
  const store = createStore()
  store.set(isHelpPanelOpenAtom, helpOpen)
  const result = render(
    <Provider store={store}>
      <AppLayout>
        <div data-testid="page" />
      </AppLayout>
    </Provider>,
  )
  return { ...result, store }
}

describe("the help panel across the wide breakpoint", () => {
  it("a narrow window widened with the help panel closed keeps it collapsed", () => {
    const { queryByTestId } = renderLayout(false)
    expect(queryByTestId("help-sidebar")).toBeNull()
    expect(queryByTestId("help-drawer")).not.toBeNull()

    expect(() => setViewport(true)).not.toThrow()

    expect(queryByTestId("help-sidebar")).not.toBeNull()
    expect(queryByTestId("help-sidebar")?.dataset.open).toBe("false")
    expect(queryByTestId("help-drawer")).toBeNull()
    expect(panelShare("help")).toBe(0)
  })

  it("a narrow window widened with the help panel open shows it", () => {
    const { queryByTestId } = renderLayout(true)
    expect(queryByTestId("help-sidebar")).toBeNull()

    expect(() => setViewport(true)).not.toThrow()

    expect(queryByTestId("help-sidebar")?.dataset.open).toBe("true")
    expect(panelShare("help")).toBe(30)
    expect(panelShare("content")).toBe(70)
  })

  it("the panel toggles on a wide window, and survives narrowing and widening again", () => {
    wide = true
    const { queryByTestId, store } = renderLayout(false)
    expect(queryByTestId("help-sidebar")?.dataset.open).toBe("false")

    act(() => store.set(isHelpPanelOpenAtom, true))
    expect(queryByTestId("help-sidebar")?.dataset.open).toBe("true")
    expect(panelShare("help")).toBe(30)

    expect(() => setViewport(false)).not.toThrow()
    expect(queryByTestId("help-sidebar")).toBeNull()
    expect(queryByTestId("help-drawer")).not.toBeNull()

    act(() => store.set(isHelpPanelOpenAtom, false))

    expect(() => setViewport(true)).not.toThrow()
    expect(queryByTestId("help-sidebar")?.dataset.open).toBe("false")
    // The group remembers the layout it last had on a wide window — the
    // panel open — and is corrected to the closed one.
    expect(panelShare("help")).toBe(0)
    expect(panelShare("content")).toBe(100)
  })
})
