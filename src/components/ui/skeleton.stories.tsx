import { NavListSkeleton, PageSkeleton } from "./skeleton"

export default {
  title: "Skeleton",
  component: PageSkeleton,
}

/** The page column while the notes are still on their way. */
export const Page = {
  render: () => (
    <div style={{ width: 640 }}>
      <PageSkeleton />
    </div>
  ),
}

/** The sidebar's note rows in the same state. */
export const NavList = {
  render: () => (
    <div style={{ width: 240, padding: 8 }}>
      <NavListSkeleton />
    </div>
  ),
}
