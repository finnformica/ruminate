### Added

- A board's pictures can be captioned and tagged by AI. **Suggest** — the sparkles in a picked picture's title bar — asks for a caption and a location, fixture and material, reusing the board's values and adding a short new one where none fits; it only fills in what is empty, as one change with one **Undo**. Under Settings → AI, paste your own Anthropic API key — kept on the server, never shown again — or, where it is offered, tick **Use Cloudflare AI** for a free model; a key you have kept is used first.

### Fixed

- A phone photo can be tagged whatever its size. Suggest used to refuse a picture over a few megabytes — a photo just taken, most often — as too large; now a smaller copy is made on the device for the model, which looks at pictures no larger than that anyway, so any upload tags and a tag costs a few hundred kilobytes of upload.
- Tagging on Cloudflare AI answers, and a failure can be copied. The free model used to think at length and its answer came back in a shape that read as nonsense; now it is asked without reasoning and read as it answers. An error toast has a **Copy** action with what went wrong, to send along.
