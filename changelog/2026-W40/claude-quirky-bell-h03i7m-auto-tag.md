### Added

- A board's pictures can be captioned and tagged by AI. **Suggest** — the sparkles in a picked picture's title bar — asks for a caption and a location, fixture and material, reusing the board's values and adding a short new one where none fits; it only fills in what is empty, as one change with one **Undo**. Under Settings → AI, paste your own Anthropic API key — kept on the server, never shown again — or, where it is offered, tick **Use Cloudflare AI** for a free model; a key you have kept is used first.
- Suggest knows where a picture was taken. A photo taken with **Camera** is placed by your phone's position — the browser asks you once — and one picked from **Photos** by the location in the picture itself, where it has one; the place is looked up and offered to Location. A picture with no position gets no hint.
- **Reset** takes every tag off a picture at once. Beside **Delete image** in a picked picture's window, it clears its location, fixture and material in one go, with one **Undo**; the caption stays.

### Changed

- Suggest gives a value for every feature the picture shows something for, in the board's own style. It used to add a new value only when nothing fit and so left features empty; now a new value is one to three words, spelled in the case of the values already there, and a value already on the board is reused exactly as written. The toast after a suggestion says **Picture updated**.

### Fixed

- A phone photo can be tagged whatever its size. Suggest used to refuse a picture over a few megabytes — a photo just taken, most often — as too large; now a smaller copy is made on the device for the model, which looks at pictures no larger than that anyway, so any upload tags and a tag costs a few hundred kilobytes of upload.
- Tagging on Cloudflare AI answers, and a failure can be copied. The free model used to think at length and its answer came back in a shape that read as nonsense; now it is asked without reasoning and read as it answers. An error toast has a **Copy** action with what went wrong, to send along.
