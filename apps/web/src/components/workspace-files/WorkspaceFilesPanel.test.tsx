// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceMissingError } from './files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

afterEach(cleanup)

describe('WorkspaceFilesPanel list states', () => {
  // The pages map their own list failures before mounting the panel, so
  // these states are the panel's own defense — e.g. a workspace deleted by
  // an agent between the page's read and the panel's.
  it('shows a calm message, not an alert, when the workspace is missing', async () => {
    const source = fakeFilesSource({
      listDocuments: () => Promise.reject(new WorkspaceMissingError('gone')),
    })
    render(<WorkspaceFilesPanel source={source} />)

    await screen.findByText('This workspace has no document tree yet.')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps the alert for a non-missing failure', async () => {
    const source = fakeFilesSource({
      listDocuments: () => Promise.reject(new Error('boom')),
    })
    render(<WorkspaceFilesPanel source={source} />)

    await screen.findByRole('alert')
  })
})

describe('WorkspaceFilesPanel create guard', () => {
  it('two same-tick presses of a create button send one create', async () => {
    let resolveCreate: (() => void) | undefined
    const source = fakeFilesSource({
      listDocuments: () =>
        Promise.resolve([{ documentId: 'd1', path: 'seed', kind: 'markdown' as const }]),
      createDocument: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveCreate = resolve
          }),
      ),
    })
    render(<WorkspaceFilesPanel source={source} />)
    await screen.findAllByTestId('card-title')

    const button = screen.getByRole('button', { name: 'New markdown document' })
    fireEvent.click(button)
    fireEvent.click(button)

    expect(source.createDocument).toHaveBeenCalledTimes(1)
    resolveCreate?.()
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
  })
})
