import { describe, expect, it } from "vitest"
import {
  isAnthropicKeyShaped,
  keyLast4,
  readTagRequest,
  readTagSuggestion,
  tagOutputSchema,
  tagPrompt,
  type TagFeature,
} from "./auto-tag"

const FEATURES: TagFeature[] = [
  { label: "Location", multi: false, values: ["Mauritius", "Lisbon"] },
  { label: "Fixture", multi: true, values: ["Lamp"] },
  { label: "Material", multi: true, values: [] },
]

describe("readTagRequest", () => {
  it("reads a request, trimming and dropping empty values", () => {
    expect(
      readTagRequest({
        imageId: "img_abcdefghijkl",
        features: [{ label: " Location ", multi: false, values: [" Mauritius", "", "Lisbon "] }],
      }),
    ).toEqual({
      imageId: "img_abcdefghijkl",
      features: [{ label: "Location", multi: false, values: ["Mauritius", "Lisbon"] }],
    })
  })

  it("takes a board with no features", () => {
    expect(readTagRequest({ imageId: "img_abcdefghijkl", features: [] })).toEqual({
      imageId: "img_abcdefghijkl",
      features: [],
    })
  })

  it("reads anything else as no request", () => {
    expect(readTagRequest(null)).toBeNull()
    expect(readTagRequest("x")).toBeNull()
    expect(readTagRequest({ imageId: 1, features: [] })).toBeNull()
    expect(readTagRequest({ imageId: "img_x", features: "Location" })).toBeNull()
    expect(readTagRequest({ imageId: "img_x", features: [{ label: "Location" }] })).toBeNull()
    expect(
      readTagRequest({ imageId: "img_x", features: [{ label: "", multi: true, values: [] }] }),
    ).toBeNull()
    expect(
      readTagRequest({ imageId: "img_x", features: [{ label: "L", multi: true, values: [1] }] }),
    ).toBeNull()
    expect(
      readTagRequest({
        imageId: "img_x",
        features: Array.from({ length: 13 }, () => ({ label: "L", multi: true, values: [] })),
      }),
    ).toBeNull()
  })
})

describe("tagPrompt", () => {
  it("lists each feature, how many values it takes, and the values in use", () => {
    expect(tagPrompt(FEATURES)).toBe(
      [
        "Features:",
        "- Location (one value): Mauritius, Lisbon",
        "- Fixture (several values): Lamp",
        "- Material (several values): none yet",
      ].join("\n"),
    )
  })

  it("asks for a caption alone on a board with no features", () => {
    expect(tagPrompt([])).toContain("caption")
  })
})

describe("tagOutputSchema", () => {
  it("is a closed object of a caption and features", () => {
    const schema = tagOutputSchema() as any
    expect(schema.required).toEqual(["caption", "features"])
    expect(schema.additionalProperties).toBe(false)
    expect(schema.properties.features.items.required).toEqual(["label", "values"])
  })
})

describe("readTagSuggestion", () => {
  it("reads values per feature in the request's order, a feature unmentioned as none", () => {
    expect(
      readTagSuggestion(
        {
          caption: "  A rattan lamp ",
          features: [
            { label: "fixture", values: ["Lamp", "Pendant"] },
            { label: "Location", values: ["Mauritius"] },
          ],
        },
        FEATURES,
      ),
    ).toEqual({
      caption: "A rattan lamp",
      features: [
        { label: "Location", values: ["Mauritius"] },
        { label: "Fixture", values: ["Lamp", "Pendant"] },
        { label: "Material", values: [] },
      ],
    })
  })

  it("keeps one value for a single-value feature, and each value once", () => {
    const read = readTagSuggestion(
      {
        caption: "x",
        features: [
          { label: "Location", values: ["Lisbon", "Mauritius"] },
          { label: "Fixture", values: ["Lamp", " lamp ", "", 3, "Pendant"] },
        ],
      },
      FEATURES,
    )
    expect(read?.features[0].values).toEqual(["Lisbon"])
    expect(read?.features[1].values).toEqual(["Lamp", "Pendant"])
  })

  it("caps how many values one feature gets, and how long a value or caption is", () => {
    const read = readTagSuggestion(
      {
        caption: "c".repeat(300),
        features: [{ label: "Fixture", values: ["a", "b", "c", "d", "e", "f", "g".repeat(99)] }],
      },
      FEATURES,
    )
    expect(read?.caption).toHaveLength(120)
    expect(read?.features[1].values).toEqual(["a", "b", "c", "d", "e"])
  })

  it("reads the first of a feature named twice, and skips entries not shaped as one", () => {
    const read = readTagSuggestion(
      {
        caption: "x",
        features: [
          null,
          { label: "Location" },
          { label: "Location", values: ["Lisbon"] },
          { label: "Location", values: ["Mauritius"] },
        ],
      },
      FEATURES,
    )
    expect(read?.features[0].values).toEqual(["Lisbon"])
  })

  it("reads anything not shaped as an answer as none", () => {
    expect(readTagSuggestion(null, FEATURES)).toBeNull()
    expect(readTagSuggestion({ caption: 3, features: [] }, FEATURES)).toBeNull()
    expect(readTagSuggestion({ caption: "x" }, FEATURES)).toBeNull()
  })
})

describe("the key's shape", () => {
  it("takes what looks like an Anthropic key and nothing else", () => {
    expect(isAnthropicKeyShaped("sk-ant-api03-" + "a".repeat(40))).toBe(true)
    expect(isAnthropicKeyShaped("sk-ant-short")).toBe(false)
    expect(isAnthropicKeyShaped("ghp_" + "a".repeat(40))).toBe(false)
    expect(isAnthropicKeyShaped("sk-ant-api03-" + "a".repeat(20) + " ")).toBe(false)
  })

  it("shows the last four characters", () => {
    expect(keyLast4("sk-ant-api03-abcdWXYZ")).toBe("WXYZ")
  })
})
