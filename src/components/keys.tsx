import React from "react"
import { cx } from "../utils/cx"

export function Keys({
  keys,
  chord = false,
  className,
}: {
  keys: string[]
  /** The keys are pressed one after another (`g` then `s`), not together:
   * they sit apart so the pair never reads as one key. */
  chord?: boolean
  className?: string
}) {
  return (
    <span
      className={cx(
        "inline-flex font-normal leading-none tracking-wider text-text-secondary",
        chord ? "gap-1" : "gap-px",
        className,
      )}
    >
      {keys.map((key, index) => {
        const isAlphabeticKey = /^[a-zA-Z]$/.test(key)
        return (
          <React.Fragment key={index}>
            {isAlphabeticKey ? <span className="font-sans-mono">{key}</span> : key}
          </React.Fragment>
        )
      })}
    </span>
  )
}
