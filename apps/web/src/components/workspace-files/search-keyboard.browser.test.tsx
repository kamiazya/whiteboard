import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

afterEach(cleanup)

const entries = [
  { documentId: 'd1', path: 'plans/roadmap', name: 'Roadmap', kind: 'markdown' as const },
  { documentId: 'd2', path: 'plans/roadmap-two', name: 'Roadmap two', kind: 'markdown' as const },
]

async function searched(onOpenDocument: (path: string) => void) {
  const source = fakeFilesSource({ listDocuments: async () => entries })
  render(<WorkspaceFilesPanel source={source} onOpenDocument={onOpenDocument} />)
  const box = await screen.findByLabelText('Search documents')
  await userEvent.click(box)
  await userEvent.keyboard('roadmap')
  await waitFor(() =>
    expect(screen.getByRole('status', { name: 'Search results' }).textContent).toBe(
      '2 results for “roadmap”',
    ),
  )
  return box
}

describe('search keyboard', () => {
  it('moves from the box to the first result and back', async () => {
    const box = await searched(vi.fn())
    await userEvent.keyboard('{ArrowDown}')
    const rows = document.querySelectorAll<HTMLElement>('[data-doc-path]')
    expect(document.activeElement).toBe(rows[0])
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(rows[1])
    await userEvent.keyboard('{ArrowUp}{ArrowUp}')
    expect(document.activeElement).toBe(box)
  })

  it('opens the focused result on Enter', async () => {
    const onOpenDocument = vi.fn()
    await searched(onOpenDocument)
    await userEvent.keyboard('{ArrowDown}{Enter}')
    expect(onOpenDocument).toHaveBeenCalledWith('plans/roadmap')
  })
})
