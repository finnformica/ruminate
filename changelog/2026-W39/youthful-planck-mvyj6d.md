### Added

- Search under a block by what it says: `under:alice` finds everything beneath every block that says "Alice", in every note. Each day's standup has its own "Alice" row, so no single block spans them, but the text does. `parent:alice` keeps to the direct children. Both take a block id too, compose with `type:`, text, `-` and comma lists, work in a note's own Filter, and never return the block itself.
