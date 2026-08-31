import { parse } from "../blocks/parse"
import { serialize } from "../blocks/serialize"

/**
 * Resolve block ids to their LIVE subtree markdown from the corpus files map
 * (`markdownFilesAtom` shape: `<id>.md` → note content) — the lookup behind
 * "paste as link" (docs/graph-storage.md). Paste must insert the node's
 * current content, never the clipboard bytes: a stale clipboard must not
 * LWW-clobber the live node on the next save.
 *
 * Each resolved id maps to block-format markdown of its whole subtree —
 * content lines with two-space nesting plus `id::` lines, exactly what
 * `serialize` emits — so `parse` rebuilds it with ids intact. An id found in
 * no file maps to null (deleted since copy; the caller falls back to the
 * clipboard-embedded content).
 *
 * `excludeFile` names the note being pasted into: its live truth is the
 * editor's own doc, and the file copy can lag it by the autosave debounce —
 * after a cut, the stale file would resurrect pre-cut bytes. Everything the
 * editor can't answer from its doc must come from the other notes only.
 */
export function resolveBlockSubtrees(
  files: Record<string, string>,
  ids: string[],
  excludeFile?: string,
): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  const pending = new Set<string>()
  for (const id of ids) {
    out[id] = null
    pending.add(id)
  }
  for (const filepath of Object.keys(files).sort()) {
    if (pending.size === 0) break
    if (!filepath.endsWith(".md") || filepath === excludeFile) continue
    const content = files[filepath]
    // Cheap pre-filter: only parse files that mention one of the ids.
    if (![...pending].some((id) => content.includes(`id:: ${id}`))) continue
    const doc = parse(content)
    for (const id of [...pending]) {
      if (!doc.blocks[id]) continue
      out[id] = serialize({ frontmatter: null, rootBlockIds: [id], blocks: doc.blocks })
      pending.delete(id)
    }
  }
  return out
}
