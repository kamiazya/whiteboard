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

/** The result the box's aria-activedescendant names, or null when none is. */
function highlighted(box: HTMLElement): HTMLElement | null {
  const id = box.getAttribute('aria-activedescendant')
  return id === null || id === '' ? null : document.getElementById(id)
}

describe('search keyboard', () => {
  it('is a combobox over the listbox of its results', async () => {
    const box = await searched(vi.fn())
    expect(box.getAttribute('role')).toBe('combobox')
    expect(box.getAttribute('aria-expanded')).toBe('true')
    const listbox = document.getElementById(box.getAttribute('aria-controls') ?? '')
    expect(listbox?.getAttribute('role')).toBe('listbox')
    expect(screen.getAllByRole('option')).toHaveLength(2)
  })

  it('arrows highlight results while focus stays in the box', async () => {
    const box = await searched(vi.fn())
    const rows = screen.getAllByRole('option')
    expect(highlighted(box)).toBeNull()
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(box)
    expect(highlighted(box)).toBe(rows[0])
    expect(rows[0]?.getAttribute('aria-selected')).toBe('true')
    await userEvent.keyboard('{ArrowDown}')
    expect(highlighted(box)).toBe(rows[1])
    expect(rows[0]?.getAttribute('aria-selected')).toBe('false')
    await userEvent.keyboard('{ArrowUp}{ArrowUp}')
    expect(highlighted(box)).toBeNull()
    expect(document.activeElement).toBe(box)
  })

  it('opens the highlighted result on Enter', async () => {
    const onOpenDocument = vi.fn()
    await searched(onOpenDocument)
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}')
    expect(onOpenDocument).toHaveBeenCalledExactlyOnceWith('plans/roadmap-two')
  })

  it('opens the first result on Enter when none is highlighted', async () => {
    const onOpenDocument = vi.fn()
    await searched(onOpenDocument)
    await userEvent.keyboard('{Enter}')
    expect(onOpenDocument).toHaveBeenCalledExactlyOnceWith('plans/roadmap')
  })

  it('Escape drops the highlight before it clears the query', async () => {
    const box = await searched(vi.fn())
    await userEvent.keyboard('{ArrowDown}{Escape}')
    expect(highlighted(box)).toBeNull()
    expect((box as HTMLInputElement).value).toBe('roadmap')
  })

  it('a result reached by Tab still walks by arrow and opens on Enter', async () => {
    const onOpenDocument = vi.fn()
    await searched(onOpenDocument)
    const rows = screen.getAllByRole('option')
    rows[0]?.focus()
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(rows[1])
    await userEvent.keyboard('{Enter}')
    expect(onOpenDocument).toHaveBeenCalledExactlyOnceWith('plans/roadmap-two')
  })
})
