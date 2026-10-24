import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  localStorage.clear()
})

function renderPanel() {
  return render(
    <WorkspaceFilesPanel
      source={fakeFilesSource({
        listDocuments: () =>
          Promise.resolve([{ documentId: 'd1', path: 'seed', kind: 'markdown' as const }]),
      })}
    />,
  )
}

describe('document browser toolbar on touch', () => {
  it('gives the search field and both column toggles a 44px target', async () => {
    renderPanel()
    const targets = [
      await screen.findByRole('searchbox', { name: 'Search documents' }),
      screen.getByRole('button', { name: 'One column' }),
      screen.getByRole('button', { name: 'Two columns' }),
    ]
    for (const el of targets) expect(el.className).toMatch(/pointer-coarse:min-h-11/)
  })

  // The results carry their own list/grid choice; a second pair above it
  // asked the same question twice with two different answers.
  it('shows one view choice while searching, the results own', async () => {
    renderPanel()
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Search documents' }), {
      target: { value: 'seed' },
    })
    await screen.findByRole('button', { name: 'List results' })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'One column' })).toBeNull())
    expect(screen.queryByRole('button', { name: 'Two columns' })).toBeNull()
  })
})
