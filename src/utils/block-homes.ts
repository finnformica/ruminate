/**
 * Where each block lives, derived from the note corpus (`markdownFilesAtom`
 * shape: `<noteId>.md` → note content). A block's "homes" are the notes whose
 * rollup declares its id on an `id::` line — under the graph model a node
 * can have several parents (docs/graph-storage.md, "Mirroring"), so a block
 * pasted as a link shows up in two notes, and a block that was merely
 * duplicated shows up in one under a fresh id. That difference is invisible in
 * the rendered text; this index is what makes it visible (the developer-mode
 * block metadata, `src/hooks/is-developer.ts`).
 *
 * The corpus file for the open note lags the editor by the autosave debounce,
 * so a block minted moments ago reports no home until the save lands.
 */
export type BlockHomesIndex = ReadonlyMap<string, readonly string[]>

const ID_LINE_RE = /^\s*id::\s+(\S+)\s*$/gm

export function buildBlockHomesIndex(files: Record<string, string>): BlockHomesIndex {
  const index = new Map<string, string[]>()
  for (const filepath of Object.keys(files).sort()) {
    if (!filepath.endsWith(".md")) continue
    const noteId = filepath.slice(0, -".md".length)
    // Cheap pre-filter: most of the cost is in files with no ids at all.
    const content = files[filepath]
    if (!content.includes("id::")) continue
    for (const match of content.matchAll(ID_LINE_RE)) {
      const id = match[1]
      const homes = index.get(id)
      if (!homes) index.set(id, [noteId])
      else if (!homes.includes(noteId)) homes.push(noteId)
    }
  }
  return index
}
