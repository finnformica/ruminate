import { getBlockType, stripMarker } from "../blocks/block-type"
import { blockId } from "../blocks/id"
import { parse } from "../blocks/parse"
import { toDisplayMarkdown } from "../blocks/to-display-markdown"
import type { Block, BlockDoc } from "../blocks/types"

/**
 * Rich clipboard round-trip for the block editor.
 *
 * Copy writes two clipboard flavors:
 * - `text/plain` — clean display markdown (as before), and
 * - `text/html` — a simple HTML rendering of the copied blocks, with the exact
 *   block tree embedded as `<meta name="x-ruminate-blocks" content="…base64
 *   json…">` inside the HTML payload. Custom clipboard MIME types are
 *   unreliable across browsers; embedding the private payload in the html
 *   flavor is the proven approach (Notion and Slack do the same).
 *
 * Paste checks for the embedded payload first: when present, the block tree is
 * rebuilt exactly (content and nesting verbatim), skipping markdown parsing
 * entirely. Foreign HTML instead goes through `htmlToMarkdown`.
 */

/**
 * One copied block: content verbatim, plus the source block's `id` when the
 * copied markdown declared one (`id::` lines). The id is what lets a
 * Ruminate→Ruminate paste LINK the original node instead of duplicating it
 * ("paste as link", docs/graph-storage.md); the content stays alongside as the
 * fallback when the node no longer exists anywhere. Neither visible flavor
 * carries ids — external interop is unchanged.
 */
export interface ClipboardBlock {
  id?: string
  content: string
  children: ClipboardBlock[]
}

const META_NAME = "x-ruminate-blocks"

/** Ids explicitly declared by `id::` lines in block-format markdown. `parse`
 * mints ids for undeclared blocks; only declared ones are real source ids the
 * payload may carry. */
function declaredIds(blockMarkdown: string): Set<string> {
  const ids = new Set<string>()
  for (const match of blockMarkdown.matchAll(/^\s*id::\s+(.+)$/gm)) ids.add(match[1].trim())
  return ids
}

/** Build both clipboard flavors from block-format markdown (content lines with
 * two-space nesting and optional `id::` lines — `selectionMarkdown` / the
 * native-copy picked lines). Declared ids ride along in the embedded payload;
 * both visible flavors drop them. */
export function richClipboardFormats(blockMarkdown: string): { plain: string; html: string } {
  return {
    plain: toDisplayMarkdown(blockMarkdown),
    html: blocksToHtml(docToClipboardBlocks(parse(blockMarkdown), declaredIds(blockMarkdown))),
  }
}

/** The copied subtree as a plain tree; a block keeps its id only when the
 * source markdown declared it (parse-minted ids are meaningless elsewhere). */
function docToClipboardBlocks(doc: BlockDoc, declared: Set<string>): ClipboardBlock[] {
  const build = (id: string): ClipboardBlock | null => {
    const block = doc.blocks[id]
    if (!block) return null
    return {
      ...(declared.has(id) ? { id } : {}),
      content: block.content,
      children: block.children.map(build).filter((b): b is ClipboardBlock => b !== null),
    }
  }
  return doc.rootBlockIds.map(build).filter((b): b is ClipboardBlock => b !== null)
}

/** Rebuild a pasted payload as a BlockDoc fragment with fresh ids throughout —
 * the DUPLICATE path (same-note paste, cycle fallback). */
export function clipboardBlocksToDoc(blocks: ClipboardBlock[]): BlockDoc {
  const map: Record<string, Block> = {}
  const build = (block: ClipboardBlock): string => {
    const id = blockId()
    map[id] = { id, content: block.content, children: block.children.map(build) }
    return id
  }
  return { frontmatter: null, rootBlockIds: blocks.map(build), blocks: map }
}

/**
 * Rebuild a pasted payload as a BlockDoc fragment KEEPING the embedded ids —
 * the LINK path's fallback when a node no longer exists anywhere (deleted
 * since copy, including the cut side of cut+paste): the clipboard content
 * comes back under the original ids, so the move still lands as a move.
 * Blocks without an id (older payloads, foreign fragments) mint fresh ones;
 * a duplicate id within the payload is reminted so the doc stays consistent.
 */
export function clipboardBlocksToDocWithIds(blocks: ClipboardBlock[]): BlockDoc {
  const map: Record<string, Block> = {}
  const build = (block: ClipboardBlock): string => {
    let id = block.id ?? blockId()
    while (id in map) id = blockId()
    const built: Block = { id, content: block.content, children: [] }
    map[id] = built
    built.children = block.children.map(build)
    return id
  }
  return { frontmatter: null, rootBlockIds: blocks.map(build), blocks: map }
}

/** A pasted payload as block-format markdown (for the edit-mode caret splice). */
export function clipboardBlocksToMarkdown(blocks: ClipboardBlock[]): string {
  const lines: string[] = []
  const walk = (block: ClipboardBlock, depth: number) => {
    lines.push("  ".repeat(depth) + block.content)
    for (const child of block.children) walk(child, depth + 1)
  }
  for (const block of blocks) walk(block, 0)
  return lines.join("\n")
}

/** The embedded Ruminate payload in a pasted `text/html` flavor, or null. */
export function extractClipboardBlocks(html: string): ClipboardBlock[] | null {
  if (!html.includes(META_NAME)) return null
  const doc = new DOMParser().parseFromString(html, "text/html")
  const meta = doc.querySelector(`meta[name="${META_NAME}"]`)
  const encoded = meta?.getAttribute("content")
  if (!encoded) return null
  try {
    const decoded: unknown = JSON.parse(decodeBase64(encoded))
    const blocks = (decoded as { blocks?: unknown }).blocks
    return isClipboardBlocks(blocks) ? blocks : null
  } catch {
    return null
  }
}

function isClipboardBlocks(value: unknown): value is ClipboardBlock[] {
  return (
    Array.isArray(value) &&
    value.every(
      (block) =>
        typeof block === "object" &&
        block !== null &&
        typeof (block as ClipboardBlock).content === "string" &&
        ((block as ClipboardBlock).id === undefined ||
          typeof (block as ClipboardBlock).id === "string") &&
        isClipboardBlocks((block as ClipboardBlock).children),
    )
  )
}

// ── HTML rendering ──────────────────────────────────────────────────────────

/** Render the copied tree as simple HTML with the private payload embedded. */
function blocksToHtml(blocks: ClipboardBlock[]): string {
  const payload = encodeBase64(JSON.stringify({ blocks }))
  return `<meta name="${META_NAME}" content="${payload}">` + renderBlocks(blocks)
}

function renderBlocks(blocks: ClipboardBlock[]): string {
  let html = ""
  let i = 0
  while (i < blocks.length) {
    const kind = getBlockType(blocks[i].content).kind
    if (kind === "bullet" || kind === "todo" || kind === "ordered") {
      // Consecutive same-flavor list items share one list element.
      const tag = kind === "ordered" ? "ol" : "ul"
      const sameFlavor = (k: string) =>
        tag === "ol" ? k === "ordered" : k === "bullet" || k === "todo"
      let items = ""
      while (i < blocks.length && sameFlavor(getBlockType(blocks[i].content).kind)) {
        items += renderListItem(blocks[i])
        i += 1
      }
      html += `<${tag}>${items}</${tag}>`
    } else {
      html += renderProse(blocks[i])
      i += 1
    }
  }
  return html
}

function renderListItem(block: ClipboardBlock): string {
  const type = getBlockType(block.content)
  const checkbox =
    type.kind === "todo" ? `<input type="checkbox"${type.checked ? " checked" : ""} disabled> ` : ""
  const children = block.children.length > 0 ? renderBlocks(block.children) : ""
  return `<li>${checkbox}${inlineHtml(stripMarker(block.content))}${children}</li>`
}

function renderProse(block: ClipboardBlock): string {
  const type = getBlockType(block.content)
  const body = inlineHtml(stripMarker(block.content))
  let html: string
  if (type.kind === "heading") {
    const level = Math.min(type.level, 6)
    html = `<h${level}>${body}</h${level}>`
  } else if (type.kind === "quote") {
    html = `<blockquote><p>${body}</p></blockquote>`
  } else {
    html = `<p>${body}</p>`
  }
  // Prose children follow as siblings — the same flattening the plain
  // display-markdown flavor applies (the embedded payload keeps exact nesting).
  if (block.children.length > 0) html += renderBlocks(block.children)
  return html
}

/** Inline markdown → simple tags (the inverse of html-to-markdown's inlines). */
function inlineHtml(text: string): string {
  // Code spans are split out first so their contents stay verbatim.
  return text
    .split(/(`[^`]*`)/)
    .map((part) => {
      if (part.length >= 2 && part.startsWith("`") && part.endsWith("`")) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`
      }
      return escapeHtml(part)
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    })
    .join("")
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

// ── Base64 (unicode-safe) ───────────────────────────────────────────────────

function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ""
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function decodeBase64(data: string): string {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

// ── Clipboard writing ───────────────────────────────────────────────────────

/**
 * Write both flavors to the clipboard from a keyboard handler (no native
 * ClipboardEvent to piggyback on).
 *
 * Approach: a synthetic copy — select a hidden span and call
 * `document.execCommand("copy")` with a one-shot capture listener that
 * overrides the event's clipboardData with every format (the technique the
 * `copy-to-clipboard` package uses internally, extended to multiple formats).
 * It's synchronous and works wherever copying works at all. If execCommand is
 * unavailable or refuses, fall back to the async Clipboard API (ClipboardItem
 * when supported, else plain writeText).
 */
export function writeRichClipboard(formats: { plain: string; html: string }): void {
  if (writeViaExecCommand(formats)) return
  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined
  if (!clipboard) return
  if (typeof ClipboardItem !== "undefined" && typeof clipboard.write === "function") {
    void clipboard
      .write([
        new ClipboardItem({
          "text/plain": new Blob([formats.plain], { type: "text/plain" }),
          "text/html": new Blob([formats.html], { type: "text/html" }),
        }),
      ])
      .catch(() => clipboard.writeText(formats.plain).catch(() => {}))
  } else if (typeof clipboard.writeText === "function") {
    void clipboard.writeText(formats.plain).catch(() => {})
  }
}

function writeViaExecCommand({ plain, html }: { plain: string; html: string }): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false
  const listener = (event: ClipboardEvent) => {
    event.stopPropagation()
    event.preventDefault()
    event.clipboardData?.setData("text/plain", plain)
    event.clipboardData?.setData("text/html", html)
  }
  // An off-screen selected span gives execCommand("copy") something to copy so
  // the copy event (which the listener overrides) actually fires.
  const span = document.createElement("span")
  span.textContent = plain
  span.style.position = "fixed"
  span.style.top = "-9999px"
  span.style.whiteSpace = "pre"
  document.body.appendChild(span)
  const selection = window.getSelection()
  const previous = selection
    ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i))
    : []
  document.addEventListener("copy", listener, true)
  try {
    const range = document.createRange()
    range.selectNodeContents(span)
    selection?.removeAllRanges()
    selection?.addRange(range)
    return document.execCommand("copy")
  } catch {
    return false
  } finally {
    document.removeEventListener("copy", listener, true)
    selection?.removeAllRanges()
    for (const range of previous) selection?.addRange(range)
    span.remove()
  }
}
