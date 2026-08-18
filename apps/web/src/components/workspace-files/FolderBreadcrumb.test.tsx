import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FolderBreadcrumb } from './FolderBreadcrumb.js'

afterEach(cleanup)

describe('FolderBreadcrumb', () => {
  // Three levels deep on purpose: at one level "the deepest segment" and
  // "the first segment" are the same row, and a trail that marked the wrong
  // one would read as correct.
  it('marks only the deepest segment as the one being shown', () => {
    render(<FolderBreadcrumb folder="design/notes/2026" onSelect={vi.fn()} />)

    expect(screen.getByRole('button', { name: '2026' }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('button', { name: 'notes' }).getAttribute('aria-current')).toBeNull()
    expect(screen.getByRole('button', { name: 'design' }).getAttribute('aria-current')).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Workspace' }).getAttribute('aria-current'),
    ).toBeNull()
  })

  // A segment's destination is the prefix UP TO it, not the segment alone —
  // clicking `notes` in `design/notes/2026` goes to `design/notes`.
  it('goes to the prefix up to the clicked segment', () => {
    const onSelect = vi.fn()
    render(<FolderBreadcrumb folder="design/notes/2026" onSelect={onSelect} />)

    fireEvent.click(screen.getByRole('button', { name: 'notes' }))
    expect(onSelect).toHaveBeenCalledWith('design/notes')

    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }))
    expect(onSelect).toHaveBeenLastCalledWith('')
  })

  it('is the root alone, and current, when nothing is open', () => {
    render(<FolderBreadcrumb folder="" onSelect={vi.fn()} />)

    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Workspace'])
    expect(screen.getByRole('button', { name: 'Workspace' }).getAttribute('aria-current')).toBe(
      'true',
    )
  })
})
