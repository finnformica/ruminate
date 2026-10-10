import { createFileRoute, redirect } from "@tanstack/react-router"
import { toDateString } from "../utils/date"

/** `/calendar` is today. */
export const Route = createFileRoute("/_appRoot/calendar/")({
  loader: () => {
    throw redirect({
      to: "/calendar/$",
      params: { _splat: toDateString(new Date()) },
      search: {},
      replace: true,
    })
  },
})
