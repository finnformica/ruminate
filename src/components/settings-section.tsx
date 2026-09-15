import React from "react"

/** One titled card on the Settings page — and on the Admin page, which is
 * laid out the same way: a bold heading, then a card of settings with a gap
 * between them so they do not read as one. */
export function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="font-bold leading-4">{title}</h3>
      <div className="card-1 flex flex-col gap-5 p-4">{children}</div>
    </div>
  )
}
