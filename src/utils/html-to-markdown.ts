/**
 * Convert a clipboard `text/html` fragment into the markdown dialect Ruminate
 * parses (src/blocks/parse.ts): one line per block, nesting via two-space
 * indentation, `- ` bullets, `1. ` ordered items, GFM task-list items
 * (`- [ ] `/`- [x] `), ATX headings, `> ` quotes, fenced code blocks, and
 * inline `**bold**` / `*italic*` / `` `code` `` / `[text](url)`.
 *
 * Everything else — spans, styles, scripts, comments, and the clipboard
 * wrappers apps emit (a `<meta>` preamble, Apple's full `<html><body>`
 * fragment, Google Docs' `<b style="font-weight:normal">` container, which is
 * NOT bold) — is stripped down to its text.
 */

const SKIPPED = new Set([
  "SCRIPT",
  "STYLE",
  "HEAD",
  "TITLE",
  "META",
  "LINK",
  "TEMPLATE",
  "NOSCRIPT",
  "IMG", // image paste is deferred — strip rather than emit a broken ref
  "INPUT", // task-list checkboxes are read at the <li> level
])

const BLOCK_TAGS = new Set([
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "P",
  "DIV",
  "UL",
  "OL",
  "LI",
  "BLOCKQUOTE",
  "PRE",
  "HR",
  "TABLE",
  "TR",
  "SECTION",
  "ARTICLE",
  "HEADER",
  "FOOTER",
  "MAIN",
  "ASIDE",
  "NAV",
  "FIGURE",
])

export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html")
  const lines = renderNodes(Array.from(doc.body.childNodes), 0)
  // Collapse blank-line runs and trim the edges.
  const out: string[] = []
  for (const line of lines) {
    if (line === "" && (out.length === 0 || out[out.length - 1] === "")) continue
    out.push(line)
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop()
  return out.join("\n")
}

/** Whether any direct child is a block-level element (so an inline wrapper —
 * e.g. Google Docs' `<b>` container around the whole payload — must be
 * treated as a transparent block container, not as inline formatting). */
function hasBlockChild(el: Element): boolean {
  for (const child of Array.from(el.children)) {
    if (BLOCK_TAGS.has(child.tagName)) return true
  }
  return false
}

/** Render a run of sibling nodes to markdown lines. `depth` is the current
 * list nesting level (2 spaces of indent per level); prose stays at the
 * margin, matching how the serializer/display markdown treat prose. */
function renderNodes(nodes: Node[], depth: number): string[] {
  const lines: string[] = []
  let buffer = ""
  const flush = () => {
    const parts = buffer
      .split("\n") // <br> → line break
      .map((part) => part.replace(/\s+/g, " ").trim())
      .filter((part) => part !== "")
    buffer = ""
    if (parts.length === 0) return
    lines.push(...parts, "")
  }

  for (const node of nodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      buffer += (node.textContent ?? "").replace(/[\t\n\r]/g, " ")
      continue
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue // comments etc.
    const el = node as Element
    const tag = el.tagName
    if (SKIPPED.has(tag)) continue
    if (tag === "BR") {
      buffer += "\n"
      continue
    }
    if (!BLOCK_TAGS.has(tag) && !hasBlockChild(el)) {
      buffer += renderInline(el)
      continue
    }
    flush()
    const heading = /^H([1-6])$/.exec(tag)
    if (heading) {
      const text = inlineText(el)
      if (text !== "") lines.push("#".repeat(Number(heading[1])) + " " + text, "")
    } else if (tag === "UL" || tag === "OL") {
      lines.push(...renderList(el, depth), "")
    } else if (tag === "BLOCKQUOTE") {
      for (const inner of renderNodes(Array.from(el.childNodes), 0)) {
        if (inner.trim() !== "") lines.push("> " + inner)
      }
      lines.push("")
    } else if (tag === "PRE") {
      const text = (el.textContent ?? "").replace(/\n$/, "")
      lines.push("```", ...text.split("\n"), "```", "")
    } else if (tag === "HR") {
      lines.push("")
    } else {
      // <p>, <div>, and any other (possibly inline-tagged) block container:
      // recurse transparently.
      lines.push(...renderNodes(Array.from(el.childNodes), depth))
    }
  }
  flush()
  return lines
}

/** Render a `<ul>`/`<ol>` to `- ` / `1. ` lines at `depth`. */
function renderList(list: Element, depth: number): string[] {
  const lines: string[] = []
  const ordered = list.tagName === "OL"
  let index = Number(list.getAttribute("start") ?? "1") || 1
  for (const item of Array.from(list.children)) {
    if (item.tagName !== "LI") continue
    lines.push(...renderListItem(item, depth, ordered ? `${index}. ` : "- "))
    if (ordered) index += 1
  }
  return lines
}

function renderListItem(li: Element, depth: number, marker: string): string[] {
  // A GFM task-list item: `<li><input type=checkbox>` (GitHub, Notion, …).
  const checkbox = li.querySelector("input[type=checkbox]")
  if (checkbox !== null && checkbox.closest("li") === li) {
    const checked = checkbox.hasAttribute("checked") || (checkbox as HTMLInputElement).checked
    marker = checked ? "- [x] " : "- [ ] "
  }

  // The item's own content vs its nested sublists.
  const own: Node[] = []
  const nested: Element[] = []
  for (const child of Array.from(li.childNodes)) {
    const tag = child.nodeType === Node.ELEMENT_NODE ? (child as Element).tagName : null
    if (tag === "UL" || tag === "OL") nested.push(child as Element)
    else own.push(child)
  }

  const indent = "  ".repeat(depth)
  const content = renderNodes(own, depth)
    .map((line) => line.trim())
    .filter((line) => line !== "")
  const lines: string[] = []
  if (content.length > 0) {
    lines.push(indent + marker + content[0])
    // Extra paragraphs/lines inside the item become child blocks.
    for (const extra of content.slice(1)) lines.push("  ".repeat(depth + 1) + extra)
  }
  const childDepth = content.length > 0 ? depth + 1 : depth
  for (const sublist of nested) lines.push(...renderList(sublist, childDepth))
  return lines
}

/** The element's content as a single collapsed inline-markdown string. */
function inlineText(el: Element): string {
  return renderInlineNodes(Array.from(el.childNodes)).replace(/\s+/g, " ").trim()
}

function renderInlineNodes(nodes: Node[]): string {
  return nodes.map(renderInlineNode).join("")
}

function renderInline(el: Element): string {
  return renderInlineNode(el)
}

function renderInlineNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? "").replace(/[\t\n\r]/g, " ")
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return ""
  const el = node as Element
  const tag = el.tagName
  if (SKIPPED.has(tag)) return ""
  const children = () => renderInlineNodes(Array.from(el.childNodes))
  switch (tag) {
    case "BR":
      return "\n"
    case "CODE": {
      const text = (el.textContent ?? "").trim()
      return text === "" ? "" : "`" + text + "`"
    }
    case "A": {
      const href = el.getAttribute("href") ?? ""
      const text = children().replace(/\s+/g, " ").trim() || href
      if (text === "") return ""
      return href === "" ? text : `[${text}](${href})`
    }
    case "B":
    case "STRONG": {
      // Google Docs wraps its whole payload in `<b style="font-weight:normal">`
      // — a container quirk, NOT bold.
      if (tag === "B" && /font-weight:\s*(normal|400)/i.test(el.getAttribute("style") ?? "")) {
        return children()
      }
      return wrap(children(), "**")
    }
    case "I":
    case "EM":
      return wrap(children(), "*")
    default: {
      // Styled spans (Google Docs emits font-weight/style on spans).
      const style = el.getAttribute("style") ?? ""
      let out = children()
      if (/font-style:\s*italic/i.test(style)) out = wrap(out, "*")
      if (/font-weight:\s*(bold|[6-9]00)/i.test(style)) out = wrap(out, "**")
      return out
    }
  }
}

/** Wrap text in an inline marker, keeping leading/trailing spaces outside it
 * (`foo <b>bar </b>baz` → `foo **bar** baz`, never the invalid `**bar **`). */
function wrap(text: string, marker: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!
  if (match[2] === "") return text
  return match[1] + marker + match[2] + marker + match[3]
}
