# Markdown syntax

Ruminate supports [GitHub Flavored Markdown](https://github.github.com/gfm/) with the following syntax extensions:

> [!NOTE]
> Wikilink (`[[id]]`) and note-embed (`![[id]]`) syntax was removed. Existing
> notes containing `[[...]]` render it as plain text — the bytes are untouched.

## Maths

Typeset a formula with [KaTeX](https://katex.org/) by wrapping it in double dollars.

```
The area is $$\pi r^2$$.
```

A line that is nothing but a formula is set in display mode: centred, with full-size operators.

```
$$\int_0^1 x^2 \, dx = \frac{1}{3}$$
```

> [!NOTE]
> Single dollars are plain text, so `$5` in a sentence is never mistaken for maths.
