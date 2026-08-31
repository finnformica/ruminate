# Markdown syntax

Ruminate supports [GitHub Flavored Markdown](https://github.github.com/gfm/) with the following syntax extensions:

> [!NOTE]
> Wikilink (`[[id]]`) and note-embed (`![[id]]`) syntax was removed. Existing
> notes containing `[[...]]` render it as plain text — the bytes are untouched.

## Tags

Link to all other notes with the same tag.

```
#<tag-name>
```

> [!NOTE]
> Tag names must start with a letter and can contain letters, numbers, hyphens, underscores, and forward slashes.

| Example   | Rendered HTML                        |
| :-------- | :----------------------------------- |
| `#recipe` | `#<a href="/tags/recipe">recipe</a>` |
