import { describe, expect, it } from "vitest"
import {
  AUTO_NOTES_SYSTEM_PROMPT,
  cloudflareNotesPrompt,
  notesOutputSchema,
  notesPrompt,
  readNotesRequest,
  readNotesSuggestion,
  type NotesRequest,
} from "./auto-notes"

const REQUEST: NotesRequest = {
  board: "Home inspiration",
  features: [
    {
      label: "Location",
      type: "place",
      multi: false,
      values: ["Mauritius", "Lisbon"],
      notes: "where the picture was taken, named as a person would say it",
    },
    { label: "Object", type: "text", multi: true, values: ["Lamp"], notes: "" },
    { label: "Link", type: "link", multi: true, values: [], notes: "" },
  ],
}

describe("readNotesRequest", () => {
  it("reads a request, trimming and cutting every string, and dropping empty values", () => {
    const read = readNotesRequest({
      board: `  ${"b".repeat(200)}`,
      features: [
        {
          label: " Object ",
          type: "text",
          multi: true,
          values: [" Lamp", "", "x".repeat(80)],
          notes: " n".repeat(300),
        },
        { label: "Link", type: "link", multi: true, values: [] },
      ],
    })
    expect(read?.board).toHaveLength(120)
    expect(read?.features[0].label).toBe("Object")
    expect(read?.features[0].values).toEqual(["Lamp", "x".repeat(60)])
    expect(read?.features[0].notes).toHaveLength(500)
    expect(read?.features[1]).toEqual({
      label: "Link",
      type: "link",
      multi: true,
      values: [],
      notes: "",
    })
  })

  it("reads anything else as no request", () => {
    expect(readNotesRequest(null)).toBeNull()
    expect(readNotesRequest({ features: [] })).toBeNull()
    expect(readNotesRequest({ board: "b" })).toBeNull()
    expect(
      readNotesRequest({ board: "b", features: [{ label: "L", multi: true, values: [] }] }),
    ).toBeNull()
    expect(
      readNotesRequest({
        board: "b",
        features: [{ label: "L", type: "colour", multi: true, values: [] }],
      }),
    ).toBeNull()
    expect(
      readNotesRequest({
        board: "b",
        features: [{ label: "", type: "text", multi: true, values: [] }],
      }),
    ).toBeNull()
    expect(
      readNotesRequest({
        board: "b",
        features: [{ label: "L", type: "text", multi: true, values: [1] }],
      }),
    ).toBeNull()
    expect(
      readNotesRequest({
        board: "b",
        features: Array.from({ length: 13 }, () => ({
          label: "L",
          type: "text",
          multi: true,
          values: [],
        })),
      }),
    ).toBeNull()
    expect(readNotesRequest({ board: "", features: [] })).toEqual({ board: "", features: [] })
  })
})

describe("the prompts", () => {
  it("tell the model its job once, in the system prompt", () => {
    expect(AUTO_NOTES_SYSTEM_PROMPT).toContain("mood board")
    expect(AUTO_NOTES_SYSTEM_PROMPT).toContain("under 120 characters, no full stop")
    expect(AUTO_NOTES_SYSTEM_PROMPT).toContain("Do not add, rename or remove features")
    expect(AUTO_NOTES_SYSTEM_PROMPT).toContain(
      "such as furniture, lighting, cutlery, plants or decoration",
    )
  })

  it("list the board's name and each feature's label, type, values and notes, and name the ones to write", () => {
    expect(notesPrompt(REQUEST)).toBe(
      [
        "Board: Home inspiration",
        "Features:",
        "- Location (place, one value): Values in use: Mauritius, Lisbon. Notes: where the picture was taken, named as a person would say it",
        "- Object (text, several values): Values in use: Lamp. Notes: none",
        "- Link (link, several values): Values in use: none yet. Notes: none",
        "Write notes for: Object, Link.",
      ].join("\n"),
    )
    const full = { ...REQUEST, features: [REQUEST.features[0]] }
    expect(notesPrompt(full)).toContain("Every feature has notes already")
    expect(notesPrompt({ ...REQUEST, board: "" })).toContain("Board: Untitled")
    expect(cloudflareNotesPrompt(REQUEST)).toContain("JSON only")
    expect(cloudflareNotesPrompt(REQUEST)).toContain("Board: Home inspiration")
  })

  it("hold the answer to a closed object of notes", () => {
    const schema = notesOutputSchema() as { required: string[]; additionalProperties: boolean }
    expect(schema.required).toEqual(["notes"])
    expect(schema.additionalProperties).toBe(false)
  })
})

describe("readNotesSuggestion", () => {
  it("matches an entry to a feature lacking notes by label, whatever its case, once each", () => {
    const read = readNotesSuggestion(
      {
        notes: [
          { label: " object ", notes: " the thing the picture is of " },
          { label: "Object", notes: "again" },
          { label: "LINK", notes: "where the picture came from" },
        ],
      },
      REQUEST,
    )
    expect(read).toEqual({
      notes: [
        { label: "Object", notes: "the thing the picture is of" },
        { label: "Link", notes: "where the picture came from" },
      ],
    })
  })

  it("drops empties, a feature not asked about, and one that has notes; cuts to length", () => {
    const read = readNotesSuggestion(
      {
        notes: [
          { label: "Object", notes: "   " },
          { label: "Colour", notes: "a colour" },
          { label: "Location", notes: "rewritten" },
          { label: "Link", notes: "x".repeat(600) },
          7,
          { label: 3, notes: "y" },
        ],
      },
      REQUEST,
    )
    expect(read?.notes).toEqual([{ label: "Link", notes: "x".repeat(500) }])
  })

  it("reads the missing features by position when the answer names none of them", () => {
    const read = readNotesSuggestion(
      {
        notes: [
          { label: "Objects", notes: "things" },
          { label: "Links", notes: "sources" },
        ],
      },
      REQUEST,
    )
    expect(read?.notes).toEqual([
      { label: "Object", notes: "things" },
      { label: "Link", notes: "sources" },
    ])
    // Not by position when the count differs, or when a label matches.
    expect(
      readNotesSuggestion({ notes: [{ label: "Objects", notes: "things" }] }, REQUEST)?.notes,
    ).toEqual([])
    expect(
      readNotesSuggestion(
        {
          notes: [
            { label: "Objects", notes: "things" },
            { label: "Link", notes: "sources" },
          ],
        },
        REQUEST,
      )?.notes,
    ).toEqual([{ label: "Link", notes: "sources" }])
  })

  it("is null for an answer not shaped as asked", () => {
    expect(readNotesSuggestion(null, REQUEST)).toBeNull()
    expect(readNotesSuggestion({ notes: "none" }, REQUEST)).toBeNull()
    expect(readNotesSuggestion({}, REQUEST)).toBeNull()
  })
})
