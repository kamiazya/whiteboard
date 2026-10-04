// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PurgeTrashEntryDialog } from './PurgeTrashEntryDialog.js'

afterEach(cleanup)

// TrashSection.purge.test.tsx reaches this dialog through a source and never
// holds the purge in flight, so whether `busy` reaches the pinned dialog is
// read only here.
describe('PurgeTrashEntryDialog', () => {
  function renderDialog(busy: boolean) {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    render(
      <PurgeTrashEntryDialog
        pending="notes/old"
        busy={busy}
        error={null}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    )
    return { onCancel, onConfirm }
  }

  it('cannot be dismissed or confirmed again while the purge is in flight', () => {
    const { onCancel } = renderDialog(true)

    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })

    expect(onCancel).not.toHaveBeenCalled()
    expect(
      (screen.getByRole('button', { name: 'Delete permanently' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('confirms and cancels through the caller when idle', () => {
    const { onCancel, onConfirm } = renderDialog(false)

    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('is closed with nothing pending', () => {
    render(
      <PurgeTrashEntryDialog
        pending={null}
        busy={false}
        error={null}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    )

    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})
