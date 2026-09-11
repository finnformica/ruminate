import yaml from "yamljs"

/** Parses frontmatter from a markdown string */
export function parseFrontmatter(markdown: string): {
  frontmatter: Record<string, unknown>
  content: string
} {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/

  try {
    const match = markdown.match(frontmatterRegex)

    if (!match) {
      return { frontmatter: {}, content: markdown }
    }

    const [, frontmatterYaml, content] = match
    const frontmatter = yaml.parse(frontmatterYaml)

    if (!frontmatter) {
      return { frontmatter: {}, content: markdown }
    }

    return { frontmatter, content: content.trimStart() }
  } catch (error) {
    console.error("Error parsing frontmatter", error)
    return { frontmatter: {}, content: markdown }
  }
}

/**
 * Returns a YAML-safe key representation, quoting when necessary.
 */
function serializeYamlKey(key: string): string {
  const isSafe = /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)
  return isSafe ? key : JSON.stringify(key)
}

/**
 * Determines if a string value needs quotes in YAML.
 * Strings need quotes when YAML would misinterpret them as other types
 * (booleans, numbers, null, dates) or when they contain special syntax.
 */
function needsYamlQuoting(str: string): boolean {
  // Empty string needs quotes
  if (str === "") return true

  // Leading/trailing whitespace needs quotes to be preserved
  if (str !== str.trim()) return true

  // Characters with special meaning in YAML at the start
  if (/^[&*!|>'"%@`#\-?:,[\]{}]/.test(str)) return true

  // Colon followed by whitespace anywhere (key-value separator)
  if (/:\s/.test(str)) return true

  // Hash anywhere (comment)
  if (/#/.test(str)) return true

  // Newlines
  if (/\n/.test(str)) return true

  // YAML boolean/null values
  const lower = str.toLowerCase()
  if (["true", "false", "yes", "no", "on", "off", "null", "~"].includes(lower)) return true

  // Numeric values (integers, floats, scientific notation)
  if (/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(str)) return true

  // Infinity and NaN
  if (/^[+-]?(\.inf|\.nan)$/i.test(str)) return true

  // Date-like patterns (YAML 1.1 timestamp) - quote to preserve as string
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return true

  return false
}

/** The exact ISO form `Date#toISOString` (and JSON date serialization)
 * produces. Emitted unquoted so it round-trips: yamljs parses it back to a
 * `Date` whose JSON form is the identical string — and so the canonical
 * serializer agrees byte-for-byte with the `updated_at` stamp
 * `updateFrontmatterValue` writes on every save. Any other date-*like* string
 * (e.g. a bare `2026-01-02`) stays quoted, because unquoted yamljs would turn
 * it into a `Date` and change the value. */
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/**
 * One value of the canonical frontmatter serialization. Nested containers are
 * emitted flow-style (`[a, b]`, `{k: v}`) — single-line, so the line-based
 * editing in `updateFrontmatterValue`/`updateFrontmatterKey` keeps working on
 * canonical output. Inside a flow context, strings additionally quote the
 * flow separators (`,` `[` `]` `{` `}`).
 */
function formatCanonicalYamlValue(value: unknown, inFlow: boolean): string {
  if (value === null || value === undefined) return "null"
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) {
    return `[${value.map((item) => formatCanonicalYamlValue(item, true)).join(", ")}]`
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
    return `{${entries
      .map(([key, item]) => `${serializeYamlKey(key)}: ${formatCanonicalYamlValue(item, true)}`)
      .join(", ")}}`
  }
  if (typeof value === "string") {
    if (ISO_DATETIME_RE.test(value)) return value
    const needsFlowQuoting = inFlow && /[,[\]{}]/.test(value)
    return needsYamlQuoting(value) || needsFlowQuoting ? JSON.stringify(value) : value
  }
  // Numbers and booleans.
  return String(value)
}

/**
 * The canonical YAML text for a set of frontmatter entries — the single
 * serialization the rollup emits for page props (docs/graph-storage.md). Key
 * order is the entries' own iteration order (which ingest derives from the
 * original document, so typical frontmatter keeps its familiar shape); every
 * value is one `key: value` line. `parse(serialize(entries))` is a fixpoint —
 * pinned by property tests, and enforced per-document by the round-trip guard
 * in `src/data/frontmatter-props.ts`.
 */
export function canonicalFrontmatterYaml(entries: Record<string, unknown>): string {
  return Object.entries(entries)
    .map(([key, value]) => `${serializeYamlKey(key)}: ${formatCanonicalYamlValue(value, false)}`)
    .join("\n")
}
