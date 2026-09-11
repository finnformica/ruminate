import { useAtomValue } from "jotai"
import { useLayoutEffect } from "react"
import { themeAtom, type Theme } from "../global-state"

export type ColorScheme = "light" | "dark"

/** The scheme a theme choice resolves to: "system" follows the device. */
export function resolveColorScheme(theme: Theme, prefersDark: boolean): ColorScheme {
  if (theme === "light" || theme === "dark") return theme
  return prefersDark ? "dark" : "light"
}

const DARK_QUERY = "(prefers-color-scheme: dark)"

/**
 * Stamp the resolved colour scheme on `<html>` as `data-theme`, which is the
 * only thing the stylesheets key off (`src/styles/variables.css`): the theme
 * picked in Settings → Appearance (`themeAtom`), with "system" following the
 * device's preference live. The browser's `theme-color` (the colour behind
 * the status bar in a home-screen app) is kept in step with the page
 * background.
 *
 * `index.html` runs the same resolution inline before first paint, so a
 * dark page never flashes light while the app boots.
 */
export function useColorScheme() {
  const theme = useAtomValue(themeAtom)

  useLayoutEffect(() => {
    const query = window.matchMedia(DARK_QUERY)
    const apply = () => {
      document.documentElement.dataset.theme = resolveColorScheme(theme, query.matches)
      syncThemeColor()
    }
    apply()
    if (theme !== "system") return
    query.addEventListener("change", apply)
    return () => query.removeEventListener("change", apply)
  }, [theme])
}

const THEME_COLOR_VAR = "--color-bg"

/** Copy the page background into `<meta name="theme-color">`. */
function syncThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]')
  if (!meta) return
  const color = window.getComputedStyle(document.body).getPropertyValue(THEME_COLOR_VAR)
  meta.setAttribute("content", color)
}
