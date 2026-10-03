### Added

- A board's pictures can be captioned and tagged by AI. **Suggest** — the sparkles in a picked picture's title bar — asks for a caption and a location, object and material, reusing the board's values and adding a short new one where none fits; it only fills in what is empty, as one change with one **Undo**. Under Settings → AI, paste your own Anthropic API key — kept on the server, never shown again — or, where it is offered, tick **Use Cloudflare AI** for a free model; a key you have kept is used first.
- Suggest knows where a picture was taken. A photo taken with **Camera** is placed by your phone's position — the browser asks you once — and one picked from **Photos** by the location in the picture itself, where it has one; the place is looked up and offered to Location. A picture with no position gets no hint.
- The toast after a suggestion can be copied. **Copy** beside **Undo** on **Picture updated** — and on **Nothing to add** — puts what the model answered on the clipboard, to send along.
- **Reset** takes a picture back to how it was uploaded. Beside **Delete image** in a picked picture's window, it clears its caption, location, object and material in one go, with one **Undo**.

### Changed

- A board's **Fixture** feature is now **Object**, and Suggest names a place the way a person would. Object is the thing the picture is of, from furniture to plants; the model is told what each feature means, and a location is given as the country, or the everyday name of a notable place such as an airport or a city, rather than the precise village. A board with a Fixture block keeps it as ordinary content: retitle it Object to carry on.
- Suggest gives a value for every feature the picture shows something for, in the board's own style. It used to add a new value only when nothing fit and so left features empty; now a new value is one to three words, spelled in the case of the values already there, and a value already on the board is reused exactly as written. The toast after a suggestion says **Picture updated**.

### Fixed

- A phone photo can be tagged whatever its size. Suggest used to refuse a picture over a few megabytes — a photo just taken, most often — as too large; now a smaller copy is made on the device for the model, which looks at pictures no larger than that anyway, so any upload tags and a tag costs a few hundred kilobytes of upload.
- Tagging on Cloudflare AI answers, and a failure can be copied. The free model used to think at length and its answer came back in a shape that read as nonsense; now it is asked without reasoning and read as it answers. An error toast has a **Copy** action with what went wrong, to send along.
