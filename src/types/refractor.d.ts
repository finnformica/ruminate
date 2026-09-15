/**
 * refractor names its modules through package.json `exports` — "refractor/core"
 * and "refractor/<language>" — which TypeScript's `node` resolution (tsconfig)
 * cannot follow; `bundler` would, but urlcat's types break under it. Vite and
 * Vitest resolve the exports themselves, so this only tells TypeScript which
 * files stand behind the two shapes (see block-editor/code-highlight.tsx).
 */
declare module "refractor/core" {
  export * from "refractor/lib/core.js"
}

declare module "refractor/*" {
  import type { Syntax } from "refractor/lib/core.js"
  const syntax: Syntax
  export default syntax
}
