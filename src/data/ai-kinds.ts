/**
 * Every use the app makes of a model, named once (docs/boards.md, "The
 * history"): the name a call is written to the history under
 * (migrations/0022, worker/ai-history.ts), so a row says what it was for
 * in a word a person reads. A new use of a model adds a name here and
 * nowhere else.
 */
export const AI_KINDS = {
  /** A picture's caption and tags, from the board's **Suggest**. */
  boardTag: "board-tag",
  /** A board's feature notes, from the Features editor's **Suggest**. */
  boardNotes: "board-notes",
} as const

export type AiKind = (typeof AI_KINDS)[keyof typeof AI_KINDS]
