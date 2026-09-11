import { Button } from "./button"
import { toastError, Toaster } from "./toast"

export default {
  title: "Toast",
  component: Toaster,
  parameters: {
    layout: "centered",
  },
}

export const Error = {
  render: () => (
    <>
      <Toaster />
      <Button onClick={() => toastError("Images must be under 10 MB")}>Fail an upload</Button>
    </>
  ),
}
