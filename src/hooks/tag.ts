import { useStore } from "jotai"
import React from "react"
import { PAGE_TYPE } from "../data/graph"
import { pagePropsEntries, pagePropsOps } from "../data/note-meta"
import type { Op } from "../data/ops"
import { useApplyOps } from "../data/store"
import { graphSnapshotAtom } from "../global-state"

/** Rename (or, with `newName` null, remove) every `#oldName` in a text. */
function renameTagInText(text: string, oldName: string, newName: string | null): string {
  return text.replace(new RegExp(`#${oldName}\\b`, "g"), newName ? `#${newName}` : "")
}

/**
 * Rename a tag everywhere it occurs: in every block's text (`setText`) and
 * in every page's `tags` prop (`setProps`). One batch; nothing else moves.
 */
export function useRenameTag() {
  const store = useStore()
  const apply = useApplyOps()

  return React.useCallback(
    async (oldName: string, newName: string | null) => {
      const snapshot = store.get(graphSnapshotAtom)
      const ops: Op[] = []
      for (const node of snapshot.nodes.values()) {
        if (node.type === PAGE_TYPE) {
          const tags = pagePropsEntries(node.props).tags
          if (!Array.isArray(tags) || !tags.includes(oldName)) continue
          const renamed = tags.map((tag) => (tag === oldName ? newName : tag)).filter(Boolean)
          ops.push(
            ...pagePropsOps(node.id, { tags: renamed.length > 0 ? renamed : null }, snapshot),
          )
          continue
        }
        const text = renameTagInText(node.text, oldName, newName)
        if (text !== node.text) ops.push({ op: "setText", id: node.id, text })
      }
      apply(ops)
    },
    [store, apply],
  )
}

export function useDeleteTag() {
  const renameTag = useRenameTag()
  return React.useCallback((tagName: string) => renameTag(tagName, null), [renameTag])
}
