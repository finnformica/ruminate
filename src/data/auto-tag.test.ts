import { describe, expect, it } from "vitest"
import { MAX_SUGGESTED_VALUE_LENGTH } from "./ai-limits"
import {
  AUTO_TAG_SYSTEM_PROMPT,
  cloudflareTagPrompt,
  extractJson,
  isAnthropicKeyShaped,
  keyLast4,
  readTagLocation,
  styledValue,
  readTagRequest,
  readTagSuggestion,
  tagOutputSchema,
  tagPrompt,
  type TagFeature,
} from "./auto-tag"

const FEATURES: TagFeature[] = [
  { label: "Location", multi: false, values: ["Mauritius", "Lisbon"], place: true },
  { label: "Object", multi: true, values: ["Lamp"] },
  { label: "Material", multi: true, values: [] },
]

describe("readTagRequest", () => {
  it("reads a request, trimming and dropping empty values", () => {
    expect(
      readTagRequest({
        features: [{ label: " Location ", multi: false, values: [" Mauritius", "", "Lisbon "] }],
      }),
    ).toEqual({
      features: [{ label: "Location", multi: false, values: ["Mauritius", "Lisbon"] }],
    })
  })

  it("takes a board with no features", () => {
    expect(readTagRequest({ features: [] })).toEqual({ features: [] })
  })

  it("keeps a place flag that is true, and drops anything else", () => {
    const read = readTagRequest({
      features: [
        { label: "Where", multi: false, values: [], place: true },
        { label: "What", multi: true, values: [], place: "yes" },
      ],
    })
    expect(read?.features).toEqual([
      { label: "Where", multi: false, values: [], place: true },
      { label: "What", multi: true, values: [] },
    ])
  })

  it("reads anything else as no request", () => {
    expect(readTagRequest(null)).toBeNull()
    expect(readTagRequest("x")).toBeNull()
    expect(readTagRequest({})).toBeNull()
    expect(readTagRequest({ features: "Location" })).toBeNull()
    expect(readTagRequest({ features: [{ label: "Location" }] })).toBeNull()
    expect(readTagRequest({ features: [{ label: "", multi: true, values: [] }] })).toBeNull()
    expect(readTagRequest({ features: [{ label: "L", multi: true, values: [1] }] })).toBeNull()
    expect(
      readTagRequest({
        features: Array.from({ length: 13 }, () => ({ label: "L", multi: true, values: [] })),
      }),
    ).toBeNull()
  })
})

describe("AUTO_TAG_SYSTEM_PROMPT", () => {
  it("asks for a value wherever the picture shows one, in the style of the values in use", () => {
    expect(AUTO_TAG_SYSTEM_PROMPT).toContain(
      "every feature the picture clearly shows something for, a value",
    )
    expect(AUTO_TAG_SYSTEM_PROMPT).toContain("one already in use when it fits, spelled exactly")
    expect(AUTO_TAG_SYSTEM_PROMPT).toContain("a new one of one to three words")
    expect(AUTO_TAG_SYSTEM_PROMPT).toContain("the same case, singular or plural as they are")
    expect(AUTO_TAG_SYSTEM_PROMPT).toContain("no value only when the picture shows nothing for it")
    expect(AUTO_TAG_SYSTEM_PROMPT).toContain("takes one value takes at most one")
    expect(AUTO_TAG_SYSTEM_PROMPT).toContain("caption of a few words (no full stop)")
    expect(AUTO_TAG_SYSTEM_PROMPT).not.toContain("only when none in use fits")
    const schema = JSON.stringify(tagOutputSchema())
    expect(schema).toContain("at most 30 characters")
    expect(schema).toContain("same case, singular or plural")
    expect(schema).not.toContain("maxLength")
  })
})

describe("tagPrompt", () => {
  it("lists each feature, how many values it takes, and the values in use", () => {
    expect(tagPrompt(FEATURES)).toBe(
      [
        "Features:",
        "- Location (one value): Values in use: Mauritius, Lisbon",
        "- Object (several values): Values in use: Lamp",
        "- Material (several values): Values in use: none yet",
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
            { label: "object", values: ["Lamp", "Pendant"] },
            { label: "Location", values: ["Mauritius"] },
          ],
        },
        FEATURES,
      ),
    ).toEqual({
      caption: "A rattan lamp",
      features: [
        { label: "Location", values: ["Mauritius"] },
        { label: "Object", values: ["Lamp", "Pendant"] },
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
          { label: "Object", values: ["Lamp", " lamp ", "", 3, "Pendant"] },
        ],
      },
      FEATURES,
    )
    expect(read?.features[0].values).toEqual(["Lisbon"])
    expect(read?.features[1].values).toEqual(["Lamp", "Pendant"])
  })

  it("caps how many values one feature gets, and how long a caption is", () => {
    const read = readTagSuggestion(
      {
        caption: "c".repeat(300),
        features: [{ label: "Object", values: ["a", "b", "c", "d", "e", "f", "g"] }],
      },
      FEATURES,
    )
    expect(read?.caption).toHaveLength(120)
    expect(read?.features[1].values).toEqual(["A", "B", "C", "D", "E"])
  })

  it("upper-cases the caption's first letter and leaves the rest", () => {
    const read = (caption: string) => readTagSuggestion({ caption, features: [] }, FEATURES)
    expect(read("a rattan lamp")?.caption).toBe("A rattan lamp")
    expect(read("étagère in oak")?.caption).toBe("Étagère in oak")
    expect(read("iPhone on a desk")?.caption).toBe("IPhone on a desk")
    expect(read("")?.caption).toBe("")
  })

  it("spells a value that matches one in use exactly as the value in use", () => {
    const read = readTagSuggestion(
      {
        caption: "x",
        features: [
          { label: "Location", values: ["  LISBON "] },
          { label: "Object", values: ["lamp", "Lamp"] },
        ],
      },
      FEATURES,
    )
    expect(read?.features[0].values).toEqual(["Lisbon"])
    expect(read?.features[1].values).toEqual(["Lamp"])
  })

  it("gives a new value the case style of the values in use", () => {
    const style = (inUse: string[], given: string) =>
      readTagSuggestion({ caption: "x", features: [{ label: "F", values: [given] }] }, [
        { label: "F", multi: true, values: inUse },
      ])?.features[0].values[0]
    expect(style(["Lamp", "Pendant"], "potted plant")).toBe("Potted plant")
    expect(style(["lamp", "pendant"], "Potted plant")).toBe("potted plant")
    expect(style(["Lamp", "pendant"], "potted plant")).toBe("Potted plant")
    expect(style([], "potted plant")).toBe("Potted plant")
    // A value in use that starts with no letter says nothing about the style.
    expect(style(["2 lamps", "pendant"], "Potted plant")).toBe("potted plant")
    expect(styledValue("ébène", ["Oak"])).toBe("Ébène")
  })

  it("cuts a new value to thirty characters, and never a value in use", () => {
    expect(MAX_SUGGESTED_VALUE_LENGTH).toBe(30)
    const long = "a very long description of a fixture indeed"
    const read = readTagSuggestion(
      { caption: "x", features: [{ label: "F", values: [long, "Lamp"] }] },
      [{ label: "F", multi: true, values: ["Lamp", "x".repeat(50)] }],
    )
    expect(read?.features[0].values[0]).toBe("A very long description of a f")
    expect(read?.features[0].values[1]).toBe("Lamp")
    const inUse = readTagSuggestion(
      { caption: "x", features: [{ label: "F", values: ["x".repeat(50)] }] },
      [{ label: "F", multi: true, values: ["x".repeat(50)] }],
    )
    expect(inUse?.features[0].values).toEqual(["x".repeat(50)])
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

describe("cloudflareTagPrompt", () => {
  it("lists the features and asks for the JSON shape in so many words", () => {
    const prompt = cloudflareTagPrompt(FEATURES)
    expect(prompt).toContain(tagPrompt(FEATURES))
    expect(prompt).toContain("JSON only")
    expect(prompt).toContain('"caption"')
    expect(prompt).toContain('"features"')
  })
})

describe("extractJson", () => {
  const object = { caption: "A lamp", features: [] }
  const text = JSON.stringify(object)

  it("reads bare JSON", () => {
    expect(extractJson(text)).toEqual(object)
  })

  it("strips a code fence, with or without a language", () => {
    expect(extractJson("```json\n" + text + "\n```")).toEqual(object)
    expect(extractJson("```\n" + text + "\n```")).toEqual(object)
  })

  it("takes the object out of the words around it", () => {
    expect(extractJson("Sure! Here is the answer:\n" + text + "\nLet me know.")).toEqual(object)
  })

  it("keeps nested braces", () => {
    const nested = { caption: "x", features: [{ label: "L", values: ["{a}"] }] }
    expect(extractJson("Answer: " + JSON.stringify(nested) + " done")).toEqual(nested)
  })

  it("is null when there is no object, or it does not parse", () => {
    expect(extractJson("I cannot see the picture.")).toBeNull()
    expect(extractJson("{not json}")).toBeNull()
    expect(extractJson("}{")).toBeNull()
    expect(extractJson("")).toBeNull()
  })
})

describe("a location in the request", () => {
  it("reads two finite numbers on the globe, and drops anything else without refusing", () => {
    const features = [{ label: "Location", multi: false, values: [] }]
    expect(readTagRequest({ features, location: { lat: 46.05127, lon: 14.50556 } })).toEqual({
      features,
      location: { lat: 46.05127, lon: 14.50556 },
    })
    for (const location of [
      { lat: 91, lon: 0 },
      { lat: 0, lon: -181 },
      { lat: "46", lon: 14 },
      { lat: Number.NaN, lon: 14 },
      { lat: 46 },
      "Ljubljana",
      null,
    ]) {
      expect(readTagRequest({ features, location })).toEqual({ features })
    }
    expect(readTagLocation({ lat: -90, lon: 180 })).toEqual({ lat: -90, lon: 180 })
    expect(readTagLocation(undefined)).toBeUndefined()
  })
})

describe("tagPrompt with a location", () => {
  const location = { lat: 46.05127, lon: 14.50556 }

  it("names the place when one was found", () => {
    const prompt = tagPrompt(FEATURES, { location, place: "Ljubljana, Slovenia" })
    expect(prompt.split("\n").at(-1)).toBe(
      "The picture was taken at: Ljubljana, Slovenia (most specific first). For Location, use a value in use that covers the place; otherwise name it as a person would in conversation — the country by default, or the everyday short name of a notable specific place such as an airport, a landmark or a city.",
    )
    expect(prompt).toContain("- Location (one value): Values in use: Mauritius, Lisbon")
  })

  it("gives the coordinates when none was", () => {
    expect(tagPrompt(FEATURES, { location, place: null }).split("\n").at(-1)).toBe(
      "The picture was taken at latitude 46.05127, longitude 14.50556: name the town or area for Location.",
    )
  })

  it("names the place features the board has, whatever they are called", () => {
    const named: TagFeature[] = [
      { label: "Where", multi: false, values: [], place: true },
      { label: "Object", multi: true, values: [] },
      { label: "Country", multi: false, values: [], place: true },
    ]
    const prompt = tagPrompt(named, { location, place: "Bled; Slovenia" })
    expect(prompt).toContain("For Where and Country, use a value in use that covers the place")
    expect(tagPrompt(named, { location, place: null })).toContain(
      "name the town or area for Where and Country.",
    )
  })

  it("says nothing of a location without one, or without a place feature to offer it to", () => {
    expect(tagPrompt(FEATURES)).not.toContain("The picture was taken")
    expect(tagPrompt([], { location, place: null })).not.toContain("The picture was taken")
    const unplaced = FEATURES.map(({ place: _place, ...feature }) => feature)
    expect(tagPrompt(unplaced, { location, place: "Bled; Slovenia" })).not.toContain(
      "The picture was taken",
    )
    expect(cloudflareTagPrompt(FEATURES, { location, place: "Bled, Slovenia" })).toContain(
      "The picture was taken at: Bled, Slovenia (most specific first)",
    )
  })
})

describe("a feature's notes", () => {
  it("travels with the request, trimmed and cut, and is dropped when it is not a string", () => {
    const read = readTagRequest({
      features: [
        { label: "Object", multi: true, values: [], notes: "  the thing the picture is of " },
        { label: "Material", multi: true, values: [], notes: 7 },
        { label: "Location", multi: false, values: [], notes: "m".repeat(600) },
      ],
    })
    expect(read?.features[0]).toEqual({
      label: "Object",
      multi: true,
      values: [],
      notes: "the thing the picture is of",
    })
    expect(read?.features[1]).toEqual({ label: "Material", multi: true, values: [] })
    expect(read?.features[2].notes).toHaveLength(500)
  })

  it("is said in the prompt before the values in use", () => {
    const prompt = tagPrompt([
      {
        label: "Object",
        multi: true,
        values: ["cutlery", "potted plant", "lamp"],
        notes:
          "the thing the picture is of, such as furniture, lighting, cutlery, plants or decoration",
      },
      { label: "Material", multi: true, values: [], notes: "what that thing is made of" },
    ])
    expect(prompt.split("\n")).toEqual([
      "Features:",
      "- Object (several values): the thing the picture is of, such as furniture, lighting, cutlery, plants or decoration. Values in use: cutlery, potted plant, lamp",
      "- Material (several values): what that thing is made of. Values in use: none yet",
    ])
  })
})

describe("an answer under other labels", () => {
  it("is read by position when it has one entry per feature in order", () => {
    const read = readTagSuggestion(
      {
        caption: "x",
        features: [
          { label: "Locations", values: ["Mauritius"] },
          { label: "Objects", values: ["potted plant"] },
          { label: "Materials", values: ["Oak"] },
        ],
      },
      FEATURES,
    )
    expect(read?.features.map((f) => f.values)).toEqual([["Mauritius"], ["Potted plant"], ["Oak"]])
  })

  it("lets a label that matches win over its position", () => {
    const read = readTagSuggestion(
      {
        caption: "x",
        features: [
          { label: "Material", values: ["Oak"] },
          { label: "Things", values: ["lamp"] },
          { label: "Location", values: ["Lisbon"] },
        ],
      },
      FEATURES,
    )
    expect(read?.features.map((f) => f.values)).toEqual([["Lisbon"], ["Lamp"], ["Oak"]])
  })

  it("ignores unknown labels when the count does not match", () => {
    const read = readTagSuggestion(
      {
        caption: "x",
        features: [
          { label: "Objects", values: ["lamp"] },
          { label: "Materials", values: ["Oak"] },
        ],
      },
      FEATURES,
    )
    expect(read?.features.map((f) => f.values)).toEqual([[], [], []])
  })
})
