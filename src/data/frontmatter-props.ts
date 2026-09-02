import yaml from "yamljs"
import { canonicalFrontmatterYaml } from "../utils/frontmatter"

/**
 * Page-node `props` ↔ frontmatter mapping (docs/graph-schema-v2.md).
 *
 * A page node's `props` column holds the note's frontmatter as **individual
 * parsed entries** — `{"updated_at": "…", "tags": […], "gist_id": "…"}` — so
 * the graph is queryable without YAML parsing and the markdown-file era's
 * `{"frontmatter": "<raw yaml>"}` blob is retired. The rollup re-serializes
 * the entries with the canonical YAML serializer
 * (`canonicalFrontmatterYaml`), which is a `parse(serialize(x))` fixpoint.
 *
 * **The legacy raw shape survives as a deliberate fallback**, in both
 * directions:
 *
 * - Ingest keeps `{"frontmatter": raw}` whenever parsing the raw text to
 *   entries and re-serializing canonically is not value-faithful: YAML that
 *   fails to parse, parses to a non-map, contains comments (which entries
 *   cannot carry — template frontmatter uses them, see
 *   `removeFrontmatterComments`), would collide with the legacy shape itself
 *   (a single `frontmatter:` string key), or fails the round-trip check.
 *   Verbatim bytes win over a lossy upgrade.
 * - The rollup accepts both shapes forever: rows pushed by an older app
 *   version (or kept legacy by the rules above) still roll up from the raw
 *   text, byte-for-byte.
 *
 * Kept dependency-light: yamljs + the canonical serializer, nothing else.
 */

/** Parse raw frontmatter YAML to a plain entries object, or null when the
 * text is not a usable YAML map. Dates and other rich values are JSON-round-
 * tripped so entries hold exactly what the JSON `props` column can store. */
function parseFrontmatterEntries(raw: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = yaml.parse(raw)
  } catch {
    return null
  }
  // Whitespace-only frontmatter parses to null — an empty entries map.
  if (parsed === null || parsed === undefined) return {}
  if (typeof parsed !== "object" || Array.isArray(parsed) || parsed instanceof Date) return null
  try {
    return JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Does the raw YAML carry a comment (whole-line, or ` #…` outside quotes)?
 * Parsed entries cannot represent comments, so such frontmatter stays in the
 * legacy raw shape rather than silently losing them. */
function hasYamlComment(raw: string): boolean {
  return raw.split("\n").some((line) => {
    const unquoted = line.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, "")
    return /^\s*#/.test(unquoted) || /\s#/.test(unquoted)
  })
}

const legacyProps = (raw: string): string => JSON.stringify({ frontmatter: raw })

/** Is this parsed `props` object the legacy raw shape? Exactly one
 * `frontmatter` key with a string value — the only shape the old ingest ever
 * wrote. */
function isLegacyShape(props: Record<string, unknown>): boolean {
  const keys = Object.keys(props)
  return keys.length === 1 && keys[0] === "frontmatter" && typeof props.frontmatter === "string"
}

/**
 * The `props` column value for a page whose note has this raw frontmatter
 * text: the parsed-entries JSON when the canonical round trip is
 * value-faithful, else the legacy `{"frontmatter": raw}` blob (see the module
 * header for the exact rules).
 */
export function pagePropsFromFrontmatter(raw: string): string {
  if (hasYamlComment(raw)) return legacyProps(raw)
  const entries = parseFrontmatterEntries(raw)
  if (entries === null || isLegacyShape(entries)) return legacyProps(raw)
  // Whitespace-only (but non-empty) frontmatter parses to zero entries; keep
  // the bytes rather than normalizing them away to an empty block.
  if (Object.keys(entries).length === 0 && raw !== "") return legacyProps(raw)
  // Round-trip guard: canonical text must parse back to the same entries.
  const reparsed = parseFrontmatterEntries(canonicalFrontmatterYaml(entries))
  if (reparsed === null || JSON.stringify(reparsed) !== JSON.stringify(entries)) {
    return legacyProps(raw)
  }
  return JSON.stringify(entries)
}

/**
 * The frontmatter text the rollup should emit for a page's `props`, or null
 * for none (`props` null, or malformed). Handles both shapes: parsed entries
 * → canonical YAML; legacy `{"frontmatter": raw}` → the raw text verbatim.
 */
export function frontmatterTextFromProps(props: string | null): string | null {
  if (props === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(props)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const entries = parsed as Record<string, unknown>
  if (isLegacyShape(entries)) return entries.frontmatter as string
  return canonicalFrontmatterYaml(entries)
}
