// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ConfirmDialog } from "./confirm-dialog"

afterEach(cleanup)

const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement

describe("ConfirmDialog", () => {
  it("asks the question, says what confirming does, and offers the verb and Cancel", () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Delete “Ideas”?"
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => {}}
      >
        Everything only it holds goes with it.
      </ConfirmDialog>,
    )
    expect(screen.getByRole("alertdialog", { name: "Delete “Ideas”?" })).toBeTruthy()
    expect(screen.getByText("Everything only it holds goes with it.")).toBeTruthy()
    expect(button("Delete")).toBeTruthy()
    expect(button("Cancel")).toBeTruthy()
  })

  it("opens on Cancel when the confirm is dangerous, and on the confirm otherwise", async () => {
    const { unmount } = render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Delete?"
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => {}}
      />,
    )
    await waitFor(() => expect(document.activeElement).toBe(button("Cancel")))
    unmount()

    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Push?"
        confirmLabel="Push"
        variant="primary"
        onConfirm={() => {}}
      />,
    )
    await waitFor(() => expect(document.activeElement).toBe(button("Push")))
  })

  it("draws a dangerous confirm in red, and a primary one as the strongest ordinary button", () => {
    const { unmount } = render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Delete?"
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => {}}
      />,
    )
    expect(button("Delete").className).toContain("bg-bg-danger")
    unmount()

    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Push?"
        confirmLabel="Push"
        onConfirm={() => {}}
      />,
    )
    expect(button("Push").className).toContain("bg-text")
  })

  it("confirms and closes at once when the work is synchronous", () => {
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Delete?"
        confirmLabel="Delete"
        onConfirm={onConfirm}
      />,
    )
    fireEvent.click(button("Delete"))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("cancels without confirming", () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Delete?"
        confirmLabel="Delete"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )
    fireEvent.click(button("Cancel"))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("holds open and busy while an async confirm is in flight, then closes", async () => {
    let resolve!: () => void
    const promise = new Promise<void>((res) => (resolve = res))
    const onConfirm = vi.fn(() => promise)
    const onOpenChange = vi.fn()
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Revoke?"
        confirmLabel="Revoke"
        variant="danger"
        onConfirm={onConfirm}
      />,
    )
    fireEvent.click(button("Revoke"))
    expect(button("Revoke").getAttribute("aria-busy")).toBe("true")
    expect(button("Cancel").disabled).toBe(true)
    expect(onOpenChange).not.toHaveBeenCalled()

    // Deaf to a second press, and to Cancel, meanwhile.
    fireEvent.click(button("Revoke"))
    fireEvent.click(button("Cancel"))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onOpenChange).not.toHaveBeenCalled()

    await act(async () => {
      resolve()
      await promise
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("shows the failure and stays open when the confirm rejects", async () => {
    const onOpenChange = vi.fn()
    let reject!: (error: Error) => void
    const promise = new Promise<void>((_, rej) => (reject = rej))
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Revoke?"
        confirmLabel="Revoke"
        onConfirm={() => promise}
      />,
    )
    fireEvent.click(button("Revoke"))
    await act(async () => {
      reject(new Error("Could not reach the server."))
      await promise.catch(() => {})
    })
    expect(screen.getByRole("alert").textContent).toBe("Could not reach the server.")
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(button("Revoke").getAttribute("aria-busy")).toBeNull()
    expect(button("Cancel").disabled).toBe(false)
  })

  it("renders nothing while closed", () => {
    render(
      <ConfirmDialog
        open={false}
        onOpenChange={() => {}}
        title="Delete?"
        confirmLabel="Delete"
        onConfirm={() => {}}
      />,
    )
    expect(screen.queryByRole("alertdialog")).toBeNull()
    expect(screen.queryByRole("button")).toBeNull()
  })
})
