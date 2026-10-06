// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DESTRUCTIVE_COPY } from '../../lib/destructive-copy.js'
import { DeleteDocumentsDialog } from './DeleteDocumentsDialog.js'

// The bulk confirmation reuses the single one: same busy pinning, same error
// slot, same buttons. Only the SUBJECT differs — a count instead of a name —
// so a `count` on the pending object is the whole difference.

afterEach(cleanup)

const noop = () => {}

describe('the delete confirmation with a count', () => {
  it('names the count instead of a document, and drops the quotes with it', () => {
    render(
      <DeleteDocumentsDialog
        pending={{ displayName: '', count: 3 }}
        busy={false}
        error={null}
        action="delete-documents"
        onCancel={noop}
        onConfirm={noop}
      />,
    )

    expect(screen.getByRole('heading').textContent).toBe('Delete 3 documents?')
  })

  it('promises the trash in the plural, from the declared copy', () => {
    render(
      <DeleteDocumentsDialog
        pending={{ displayName: '', count: 2 }}
        busy={false}
        error={null}
        action="delete-documents"
        onCancel={noop}
        onConfirm={noop}
      />,
    )

    expect(
      screen.getByText(DESTRUCTIVE_COPY['delete-documents']('documents'), { exact: false }),
    ).toBeTruthy()
  })

  it('still names the document when there is no count', () => {
    render(
      <DeleteDocumentsDialog
        pending={{ displayName: 'Roadmap', kind: 'spatial' }}
        busy={false}
        error={null}
        action="delete-document"
        onCancel={noop}
        onConfirm={noop}
      />,
    )

    expect(screen.getByRole('heading').textContent).toBe('Delete "Roadmap"?')
  })
})

describe('the delete confirmation while the delete is in flight', () => {
  function renderDialog(busy: boolean) {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    render(
      <DeleteDocumentsDialog
        pending={{ displayName: 'Plan', kind: 'markdown' }}
        busy={busy}
        error={null}
        action="delete-document"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    )
    return { onCancel, onConfirm }
  }

  it('ignores Escape and disables both buttons when busy', () => {
    const { onCancel } = renderDialog(true)

    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })

    expect(onCancel).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('cancels on Escape and confirms from Delete when idle', () => {
    const { onCancel, onConfirm } = renderDialog(false)

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
