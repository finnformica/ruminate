/**
 * What is upstream of each block, derived from the note corpus
 * (`markdownFilesAtom` shape: `<noteId>.md` → note content): the notes whose
 * rollup declares its id on an `id::` line, i.e. the pages that reach the
 * node through child links. Under the graph model a node can have several
 * upstream links (docs/graph-storage.md, "Mirroring"), so a block pasted as a
 * link is upstream of two notes, and a block that was merely duplicated is
 * upstream of one under a fresh id. That difference is invisible in the
 * rendered text; this index is what makes it visible (the developer-mode
 * block metadata, `src/hooks/is-developer.ts`).
 *
 * The corpus file for the open note lags the editor by the autosave debounce,
 * so a block minted moments ago reports nothing upstream until the save lands.
 */
export type UpstreamIndex = ReadonlyMap<string, readonly string[]>

const ID_LINE_RE = /^\s*id::\s+(\S+)\s*$/gm

export function buildUpstreamIndex(files: Record<string, string>): UpstreamIndex {
  const index = new Map<string, string[]>()
  for (const filepath of Object.keys(files).sort()) {
    if (!filepath.endsWith(".md")) continue
    const noteId = filepath.slice(0, -".md".length)
    // Cheap pre-filter: most of the cost is in files with no ids at all.
    const content = files[filepath]
    if (!content.includes("id::")) continue
    for (const match of content.matchAll(ID_LINE_RE)) {
      const id = match[1]
      const upstream = index.get(id)
      if (!upstream) index.set(id, [noteId])
      else if (!upstream.includes(noteId)) upstream.push(noteId)
    }
  }
  return index
}
