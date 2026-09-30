import type { BoardFeatureState } from "../../data/boards"
import { Button } from "../button"
import { DropdownMenu } from "../dropdown-menu"
import { ChevronDownIcon16 } from "../icons"
import { SearchInput } from "../search-input"

/**
 * Narrowing the board: words matched against captions, and one value per
 * feature (the chosen values intersect, as `in:` scopes do in a search).
 * Only a feature with values on the page gets a menu — there is nothing to
 * narrow by until a picture has been given one.
 */
export function BoardFilters({
  features,
  active,
  counts,
  text,
  onText,
  onPick,
  onClear,
}: {
  features: BoardFeatureState[]
  /** The chosen value of each feature, by the feature's label. */
  active: ReadonlyMap<string, string>
  /** How many of the board's pictures carry each value, by value id. */
  counts: ReadonlyMap<string, number>
  text: string
  onText: (text: string) => void
  onPick: (feature: BoardFeatureState, valueId: string | null) => void
  onClear: () => void
}) {
  const withValues = features.filter((state) => state.values.length > 0)
  const narrowed = active.size > 0 || text.trim() !== ""
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="w-full sm:w-64">
        <SearchInput placeholder="Search captions…" value={text} onChange={onText} />
      </div>
      {withValues.map((state) => {
        const chosenId = active.get(state.feature.label) ?? null
        const chosen = state.values.find((value) => value.id === chosenId) ?? null
        return (
          <DropdownMenu key={state.feature.label} modal={false}>
            <DropdownMenu.Trigger
              render={
                <Button size="small" selected={chosen !== null} className="gap-1.5">
                  {chosen ? `${state.feature.label}: ${chosen.text}` : state.feature.label}
                  <ChevronDownIcon16 className="text-text-secondary" />
                </Button>
              }
            />
            <DropdownMenu.Content align="start" width={224}>
              <DropdownMenu.Item selected={chosen === null} onClick={() => onPick(state, null)}>
                Any
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              {state.values.map((value) => (
                <DropdownMenu.Item
                  key={value.id}
                  selected={value.id === chosenId}
                  trailingVisual={
                    <span className="text-sm text-text-secondary">{counts.get(value.id) ?? 0}</span>
                  }
                  onClick={() => onPick(state, value.id)}
                >
                  {value.text.trim() || "Untitled"}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu>
        )
      })}
      {narrowed ? (
        <Button size="small" onClick={onClear}>
          Clear
        </Button>
      ) : null}
    </div>
  )
}
