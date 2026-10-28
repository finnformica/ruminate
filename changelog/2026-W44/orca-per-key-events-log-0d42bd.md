### Changed

- Two devices that change different details of one block both keep their change. A picture resized on the phone and realigned on the laptop, while one of them was offline, used to keep only the newer of the two edits; now each detail is its own change, and both land. The same holds for a note's font and width, and for any other metadata of a block.
- A day on the calendar names the details a row changed. A row whose words did not change but whose size, alignment or other metadata did is marked as changed, with the names of what changed after it.
- The MCP `update_block` tool can change one piece of a block's metadata. `set_props` sets the keys it names and leaves the others as they are; `unset_props` removes keys. `props` still replaces the whole object.
