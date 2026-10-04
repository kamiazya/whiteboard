// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PinnedConfirmDialog } from './pinned-confirm-dialog.js'

afterEach(cleanup)

function renderDialog(props: Partial<Parameters<typeof PinnedConfirmDialog>[0]> = {}) {
  const onCancel = vi.fn()
  const onConfirm = vi.fn()
  render(
    <PinnedConfirmDialog
      open
      busy={false}
      title="Delete it?"
      description="This cannot be undone."
      confirmLabel="Delete"
      onCancel={onCancel}
      onConfirm={onConfirm}
      {...props}
    />,
  )
  return { onCancel, onConfirm }
}

describe('PinnedConfirmDialog', () => {
  it('asks to cancel on Escape while idle', () => {
    const { onCancel } = renderDialog()
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('ignores Escape while busy', () => {
    const { onCancel } = renderDialog({ busy: true })
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toBeTruthy()
  })

  it('ignores a press on the overlay while busy', () => {
    const { onCancel } = renderDialog({ busy: true })
    const overlay = document.querySelector('[data-slot="alert-dialog-overlay"]')
    expect(overlay).not.toBeNull()
    fireEvent.pointerDown(overlay as Element)
    fireEvent.click(overlay as Element)
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toBeTruthy()
  })

  it('disables both buttons while busy', () => {
    renderDialog({ busy: true })
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect((screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('fires the confirmation once and leaves closing to the caller', () => {
    const { onConfirm, onCancel } = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toBeTruthy()
  })

  it('cancels from the Cancel button', () => {
    const { onCancel } = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('shows the error under the description', () => {
    renderDialog({ error: 'Server said no' })
    expect(screen.getByText('Server said no')).toBeTruthy()
  })

  it('renders nothing when closed', () => {
    renderDialog({ open: false })
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('hands the close-focus event to the caller', async () => {
    const onCloseAutoFocus = vi.fn((event: Event) => event.preventDefault())
    const view = render(
      <PinnedConfirmDialog
        open
        busy={false}
        title="t"
        description="d"
        confirmLabel="Go"
        onCancel={() => {}}
        onConfirm={() => {}}
        onCloseAutoFocus={onCloseAutoFocus}
      />,
    )
    view.rerender(
      <PinnedConfirmDialog
        open={false}
        busy={false}
        title="t"
        description="d"
        confirmLabel="Go"
        onCancel={() => {}}
        onConfirm={() => {}}
        onCloseAutoFocus={onCloseAutoFocus}
      />,
    )
    await vi.waitFor(() => expect(onCloseAutoFocus).toHaveBeenCalled())
  })
})
