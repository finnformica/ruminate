import { useNavigate } from "@tanstack/react-router"
import React from "react"
import { toast } from "sonner"
import { databaseAllRows } from "../data/database-mode"
import { deletedNotesOf, restoreNoteOps, type CorpusRows } from "../data/deleted-notes"
import { useApplyOps } from "../data/store"
import { AsyncButton } from "./ui/async-button"
import { Skeleton } from "./ui/skeleton"
import { SettingsSection } from "./settings-section"

/**
 * Settings' **Recently deleted**: the notes the local database still holds
 * under a tombstone (`src/data/deleted-notes.ts`), newest first, each with a
 * button that restores it — the note, and every block that went with it.
 * Read once when the section opens and again after each restore; a delete
 * elsewhere in the app while the page is open shows up on the next visit.
 * Own notes only: a note someone shared with the user is the owner's, and
 * its tombstones are in the owner's corpus.
 */
export function DeletedNotesSection() {
  const navigate = useNavigate()
  const apply = useApplyOps()
  // Undefined until the first read answers; null when the runtime is down.
  const [rows, setRows] = React.useState<CorpusRows | null | undefined>(undefined)

  const load = React.useCallback(async () => {
    setRows(await databaseAllRows())
  }, [])

  React.useEffect(() => {
    let cancelled = false
    databaseAllRows().then((next) => {
      if (!cancelled) setRows(next)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const notes = React.useMemo(() => (rows ? deletedNotesOf(rows) : []), [rows])

  const restore = async (id: string, title: string) => {
    if (!rows) return
    apply(restoreNoteOps(id, rows))
    toast(`Restored “${title}”.`, {
      action: {
        label: "Open",
        onClick: () =>
          navigate({ to: "/notes/$", params: { _splat: id }, search: { query: undefined } }),
      },
    })
    await load()
  }

  return (
    <SettingsSection title="Recently deleted">
      <div className="flex flex-col gap-1">
        <span className="leading-4">Deleted notes</span>
        <span className="text-sm leading-5 text-text-secondary">
          A deleted note is kept, and can be restored with everything only it held. A block that was
          also in another note stays where it is.
        </span>
      </div>
      {rows === undefined ? (
        <div role="status" aria-label="Loading" className="flex flex-col gap-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : notes.length === 0 ? (
        <span className="text-sm leading-5 text-text-secondary">Nothing has been deleted.</span>
      ) : (
        <ul className="flex flex-col divide-y divide-border-secondary">
          {notes.map((note) => (
            <li key={note.id} className="flex items-center justify-between gap-4 py-2">
              <div className="flex w-0 grow flex-col gap-1">
                <span className="truncate leading-4">{note.title}</span>
                <span className="text-sm leading-4 text-text-secondary">
                  Deleted {formatDeletedAt(note.deletedAt)} ·{" "}
                  {note.blocks === 1 ? "1 block" : `${note.blocks} blocks`}
                </span>
              </div>
              <AsyncButton
                size="small"
                className="shrink-0"
                onClick={() => restore(note.id, note.title)}
              >
                Restore
              </AsyncButton>
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  )
}

function formatDeletedAt(at: number): string {
  return new Date(at).toLocaleString([], {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })
}
