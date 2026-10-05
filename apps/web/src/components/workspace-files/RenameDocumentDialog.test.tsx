// @vitest-environment jsdom
/**
 * The dialog on its own, for what it refuses before anything is moved. The
 * panel-level flow is `rename-document-dialog.test.tsx`.
 */
import { DOCUMENT_PATH_MAX_LENGTH } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RenameDocumentDialog } from './RenameDocumentDialog.js'

afterEach(cleanup)

const entry = {
  documentId: 'd1',
  path: 'design/login',
  name: 'Login flow',
  kind: 'spatial' as const,
}

function renderDialog(error: string | null = null) {
  const onSubmit = vi.fn()
  render(
    <RenameDocumentDialog
      document={entry}
      workspace="design"
      busy={false}
      error={error}
      onCancel={() => {}}
      onSubmit={onSubmit}
    />,
  )
  const dialog = screen.getByRole('dialog')
  return { dialog, onSubmit, path: within(dialog).getByLabelText(/^Path/) as HTMLInputElement }
}

// A keeper used to store an off-grammar path, after which its listing could
// not read the workspace at all. The dialog says what is wrong before the
// move is asked for.
describe('RenameDocumentDialog — a path the model refuses', () => {
  it('says why, and does not submit', () => {
    const { dialog, onSubmit, path } = renderDialog()
    fireEvent.change(path, { target: { value: 'design/Meeting notes' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(within(dialog).getByRole('alert').textContent).toMatch(/segment/i)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('submits once the path is corrected, and drops the stale refusal', () => {
    const { dialog, onSubmit, path } = renderDialog()
    fireEvent.change(path, { target: { value: 'design/Meeting notes' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    fireEvent.change(path, { target: { value: 'design/meeting-notes' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(onSubmit).toHaveBeenCalledWith('Login flow', 'design/meeting-notes')
    expect(within(dialog).queryByRole('alert')).toBeNull()
  })

  it('still renames a document whose stored path predates the grammar', () => {
    const onSubmit = vi.fn()
    render(
      <RenameDocumentDialog
        document={{ ...entry, path: 'Meeting notes' }}
        busy={false}
        error={null}
        onCancel={() => {}}
        onSubmit={onSubmit}
      />,
    )
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Minutes' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(onSubmit).toHaveBeenCalledWith('Minutes', 'Meeting notes')
  })

  it('caps the path at the length the model accepts', () => {
    const { path } = renderDialog()
    expect(path.maxLength).toBe(DOCUMENT_PATH_MAX_LENGTH)
  })
})
