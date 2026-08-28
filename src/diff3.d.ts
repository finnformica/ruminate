/**
 * Types for the `diff3` package (the same diff3 engine isomorphic-git uses for
 * its builtin merge driver — it ships no types of its own).
 */
declare module "diff3" {
  export type Diff3MergeRegion<T> = {
    ok?: T[]
    conflict?: {
      a: T[]
      aIndex: number
      o: T[]
      oIndex: number
      b: T[]
      bIndex: number
    }
  }

  export default function diff3Merge<T>(a: T[], o: T[], b: T[]): Diff3MergeRegion<T>[]
}
