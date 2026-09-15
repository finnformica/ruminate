import { Fragment, useEffect, useMemo, useReducer, type ReactNode } from "react"
import { refractor } from "refractor/core"

/**
 * **Syntax highlighting for a code block's view.** The block's text is
 * tokenised by Prism's grammars (`refractor`: the same grammars as pure
 * functions, one small module per language) and drawn as spans carrying
 * Prism's token classes, which `src/styles/prism.css` colours from the
 * theme's syntax variables — so highlighting follows the accent, the
 * scheme and print like everything else. Only the view is highlighted: the
 * textarea shows the text plain, in the same face and size, so the swap
 * between them changes colour and nothing else.
 *
 * A grammar is fetched the first time a block in its language is drawn (its
 * own chunk, a few KB), and the block shows plain text until it lands. An
 * unknown language, or none, stays plain: the language is whatever followed
 * the fence, so it is never trusted to exist.
 */

type Syntax = Parameters<typeof refractor.register>[0]
type Loader = () => Promise<{ default: Syntax }>

/** The grammars on offer, by Prism's name for them. Each is its own chunk. */
const GRAMMARS: Record<string, Loader> = {
  bash: () => import("refractor/bash"),
  c: () => import("refractor/c"),
  cpp: () => import("refractor/cpp"),
  csharp: () => import("refractor/csharp"),
  css: () => import("refractor/css"),
  diff: () => import("refractor/diff"),
  docker: () => import("refractor/docker"),
  go: () => import("refractor/go"),
  graphql: () => import("refractor/graphql"),
  ini: () => import("refractor/ini"),
  java: () => import("refractor/java"),
  javascript: () => import("refractor/javascript"),
  json: () => import("refractor/json"),
  jsx: () => import("refractor/jsx"),
  kotlin: () => import("refractor/kotlin"),
  lua: () => import("refractor/lua"),
  makefile: () => import("refractor/makefile"),
  markdown: () => import("refractor/markdown"),
  markup: () => import("refractor/markup"),
  php: () => import("refractor/php"),
  powershell: () => import("refractor/powershell"),
  python: () => import("refractor/python"),
  r: () => import("refractor/r"),
  ruby: () => import("refractor/ruby"),
  rust: () => import("refractor/rust"),
  scss: () => import("refractor/scss"),
  sql: () => import("refractor/sql"),
  swift: () => import("refractor/swift"),
  toml: () => import("refractor/toml"),
  tsx: () => import("refractor/tsx"),
  typescript: () => import("refractor/typescript"),
  yaml: () => import("refractor/yaml"),
}

/** What people write after a fence, to Prism's name. */
const ALIASES: Record<string, string> = {
  "c++": "cpp",
  cs: "csharp",
  dockerfile: "docker",
  golang: "go",
  htm: "markup",
  html: "markup",
  js: "javascript",
  jsonc: "json",
  kt: "kotlin",
  md: "markdown",
  mjs: "javascript",
  ps1: "powershell",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sass: "scss",
  sh: "bash",
  shell: "bash",
  svg: "markup",
  ts: "typescript",
  xml: "markup",
  yml: "yaml",
  zsh: "bash",
}

/** The grammar name for a fence's language, or null if there is none for it. */
function grammarFor(language: string): string | null {
  const lower = language.trim().toLowerCase()
  if (!lower) return null
  const name = ALIASES[lower] ?? lower
  return name in GRAMMARS ? name : null
}

const loads = new Map<string, Promise<void>>()

/** Fetch and register a grammar, once. */
function load(name: string): Promise<void> {
  let pending = loads.get(name)
  if (!pending) {
    pending = GRAMMARS[name]().then((mod) => {
      if (!refractor.registered(name)) refractor.register(mod.default)
    })
    loads.set(name, pending)
  }
  return pending
}

/** Whether the grammar is registered — fetching it if not, and re-rendering
 * once it is. */
function useGrammar(name: string | null): boolean {
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  const ready = name !== null && refractor.registered(name)
  useEffect(() => {
    if (name === null || ready) return
    let live = true
    load(name).then(
      () => live && rerender(),
      () => {
        // The chunk failed to fetch (offline, say): the block stays plain.
      },
    )
    return () => {
      live = false
    }
  }, [name, ready])
  return ready
}

/** The slice of hast that `refractor.highlight` produces. */
interface HastNode {
  type: string
  value?: string
  properties?: { className?: string[] }
  children?: HastNode[]
}

function toReact(nodes: HastNode[] | undefined): ReactNode {
  if (!nodes) return null
  return nodes.map((node, index) =>
    node.type === "text" ? (
      <Fragment key={index}>{node.value}</Fragment>
    ) : node.type === "element" ? (
      <span key={index} className={node.properties?.className?.join(" ")}>
        {toReact(node.children)}
      </span>
    ) : null,
  )
}

/** A code block's text, tokenised for its language — or plain, as above. */
export function CodeHighlight({ text, language }: { text: string; language: string }) {
  const name = grammarFor(language)
  const ready = useGrammar(name)
  const tree = useMemo(
    () => (ready && name !== null && text !== "" ? refractor.highlight(text, name) : null),
    [ready, name, text],
  )
  if (!tree) return <>{text}</>
  return <>{toReact((tree as HastNode).children)}</>
}
