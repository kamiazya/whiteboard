// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('duplicating a document from its menu', () => {
  it('says what was duplicated, offers to open the copy, and selects it', async () => {
    let rows: WorkspaceDocumentEntry[] = [
      { documentId: 'd1', path: 'budget', name: 'Budget review', kind: 'markdown' },
      { documentId: 'd2', path: 'notes', name: 'Notes', kind: 'markdown' },
    ]
    const source = fakeFilesSource({ listDocuments: async () => rows })
    const onOpenDocument = vi.fn()
    let revision = 0
    const panel = () => (
      <WorkspaceFilesPanel
        source={source}
        revision={revision}
        onOpenDocument={onOpenDocument}
        onDuplicateDocument={(path) => {
          rows = [
            ...rows,
            {
              documentId: 'd3',
              path: `${path}-copy`,
              name: 'Budget review (copy)',
              kind: 'markdown',
            },
          ]
          revision += 1
          view.rerender(panel())
        }}
      />
    )
    const view = render(panel())

    const card = (await screen.findAllByTestId('card-title'))
      .find((each) => each.textContent === 'Budget review')
      ?.closest('button') as HTMLElement
    fireEvent.contextMenu(card, { clientX: 5, clientY: 5 })
    const menu = await screen.findByRole('menu', { name: 'Document actions' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Duplicate' }))

    const toast = await screen.findByText('Duplicated Budget review')
    // The live region speaks the sentence alone: the Open button's text
    // inside it ran on as "…reviewOpen".
    expect(toast.closest('[role="status"]')?.textContent).toBe('Duplicated Budget review')
    const copyCard = (await screen.findAllByTestId('card-title'))
      .find((each) => each.textContent === 'Budget review (copy)')
      ?.closest('button') as HTMLElement
    await waitFor(() => expect(copyCard.getAttribute('aria-current')).toBe('true'))

    fireEvent.click(
      within(toast.parentElement as HTMLElement).getByRole('button', { name: 'Open' }),
    )
    expect(onOpenDocument).toHaveBeenCalledWith('budget-copy')
  })

  it('names a copy made without comments as one', async () => {
    let rows: WorkspaceDocumentEntry[] = [
      { documentId: 'd1', path: 'budget', name: 'Budget review', kind: 'markdown' },
    ]
    const source = fakeFilesSource({ listDocuments: async () => rows })
    let revision = 0
    const panel = () => (
      <WorkspaceFilesPanel
        source={source}
        revision={revision}
        onDuplicateDocument={(path) => {
          rows = [
            ...rows,
            {
              documentId: 'd3',
              path: `${path}-copy`,
              name: 'Budget review (copy)',
              kind: 'markdown',
            },
          ]
          revision += 1
          view.rerender(panel())
        }}
      />
    )
    const view = render(panel())

    const card = (await screen.findAllByTestId('card-title'))
      .find((each) => each.textContent === 'Budget review')
      ?.closest('button') as HTMLElement
    fireEvent.contextMenu(card, { clientX: 5, clientY: 5 })
    const menu = await screen.findByRole('menu', { name: 'Document actions' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Duplicate without comments' }))

    expect(await screen.findByText('Duplicated Budget review without comments')).toBeTruthy()
  })

  it('does not take a document arriving long after a duplicate that never landed for its copy', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    let rows: WorkspaceDocumentEntry[] = [
      { documentId: 'd1', path: 'budget', name: 'Budget review', kind: 'markdown' },
    ]
    const source = fakeFilesSource({ listDocuments: async () => rows })
    let revision = 0
    // The duplicate fails: the page reports it elsewhere and lists nothing new.
    const panel = () => (
      <WorkspaceFilesPanel source={source} revision={revision} onDuplicateDocument={() => {}} />
    )
    const view = render(panel())
    const card = (await screen.findAllByTestId('card-title'))
      .find((each) => each.textContent === 'Budget review')
      ?.closest('button') as HTMLElement
    fireEvent.contextMenu(card, { clientX: 5, clientY: 5 })
    const menu = await screen.findByRole('menu', { name: 'Document actions' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Duplicate' }))

    vi.setSystemTime(Date.now() + 60_000)
    rows = [...rows, { documentId: 'd9', path: 'standup', name: 'Standup', kind: 'markdown' }]
    revision += 1
    view.rerender(panel())
    const arrived = (
      await screen.findByText('Standup', { selector: '[data-testid="card-title"]' })
    ).closest('button') as HTMLElement
    expect(screen.queryByText(/^Duplicated /)).toBeNull()
    expect(arrived.getAttribute('aria-current')).not.toBe('true')
  })
})
