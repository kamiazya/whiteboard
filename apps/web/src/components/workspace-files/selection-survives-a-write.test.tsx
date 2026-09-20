// @vitest-environment jsdom
/**
 * What a write leaves SELECTED.
 *
 * Five flows re-read the list after changing it — a create, a rename that
 * only renamed, a rename that was refused, a pin toggle, and a move — and
 * every one of them re-selects the row it acted on, so the preview pane keeps
 * showing the document the person was working with instead of emptying.
 *
 * Nothing pinned that. The five sites were three identical lines each, and
 * replacing the re-selection with `setSelected(null)` left all 286 jsdom
 * tests and all 29 browser tests green. They are one `refreshAndSelect` now,
 * so one test covers the rule for all five.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

afterEach(cleanup)

const before: readonly WorkspaceDocumentEntry[] = [
  { documentId: 'd1', path: 'meeting-notes', name: 'Meeting notes', kind: 'markdown' },
  { documentId: 'd2', path: 'plans/roadmap', name: 'Roadmap', kind: 'spatial' },
]

/** The same rows with `d1` renamed — what the re-read returns afterwards. */
const after: readonly WorkspaceDocumentEntry[] = [
  { documentId: 'd1', path: 'meeting-notes', name: 'Standup notes', kind: 'markdown' },
  { documentId: 'd2', path: 'plans/roadmap', name: 'Roadmap', kind: 'spatial' },
]

async function selectCard(title: string) {
  await waitFor(() => {
    expect(screen.getAllByTestId('card-title').some((el) => el.textContent === title)).toBe(true)
  })
  const card = screen
    .getAllByTestId('card-title')
    .find((node) => node.textContent === title)
    ?.closest('button')
  fireEvent.click(card as HTMLElement)
}

describe('a write leaves the row it acted on selected', () => {
  it('keeps the renamed document in the preview instead of emptying it', async () => {
    let rows = before
    const source = fakeFilesSource({
      listDocuments: async () => rows,
      setDocumentName: async () => {
        rows = after
      },
    })
    render(<WorkspaceFilesPanel source={source} onOpenDocument={() => {}} />)

    await selectCard('Meeting notes')
    const preview = await screen.findByTestId('okf-preview')
    expect(within(preview).getByText('Meeting notes')).toBeTruthy()

    fireEvent.click(within(preview).getByRole('button', { name: /rename/i }))
    const dialog = await screen.findByRole('dialog')
    // Two textboxes, neither with an accessible name: the first is the NAME
    // field (its placeholder is the path's last segment), the second is
    // DocumentPathField. Probed rather than assumed.
    const nameField = within(dialog).getAllByRole('textbox')[0] as HTMLElement
    fireEvent.change(nameField, { target: { value: 'Standup notes' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    // The row is still selected, and it is the row as the re-read now
    // describes it — not the stale copy the dialog was opened from.
    await waitFor(() => {
      expect(within(screen.getByTestId('okf-preview')).getByText('Standup notes')).toBeTruthy()
    })
  })

  it('closes the rename dialog once the write has landed', async () => {
    // Mutation-checked when the flow moved into `useRenameDocument`: nothing
    // asserted that a SUCCESSFUL rename closes the dialog. Leaving it open
    // over the renamed document passed all 287 jsdom tests, and the refusal
    // path has its own case in rename-document-dialog.test.tsx — so the
    // happy path was the half nobody watched.
    let rows = before
    const source = fakeFilesSource({
      listDocuments: async () => rows,
      setDocumentName: async () => {
        rows = after
      },
    })
    render(<WorkspaceFilesPanel source={source} onOpenDocument={() => {}} />)

    await selectCard('Meeting notes')
    const preview = await screen.findByTestId('okf-preview')
    fireEvent.click(within(preview).getByRole('button', { name: /rename/i }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getAllByRole('textbox')[0] as HTMLElement, {
      target: { value: 'Standup notes' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
  })
})
