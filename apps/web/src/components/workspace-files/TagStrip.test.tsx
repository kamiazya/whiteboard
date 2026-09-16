import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TagStrip } from './TagStrip.js'

afterEach(cleanup)

const rows = [
  {
    tag: 'health:failing',
    key: 'health',
    value: 'failing',
    documents: 0,
    boards: 0,
    nodes: 1,
    edges: 0,
  },
  { tag: 'health:ok', key: 'health', value: 'ok', documents: 0, boards: 1, nodes: 2, edges: 0 },
  { tag: 'q3', documents: 2, boards: 1, nodes: 0, edges: 0 },
  { tag: 'release', documents: 1, boards: 0, nodes: 0, edges: 0 },
]

describe('TagStrip', () => {
  it('lists plain tags first, then each key with its values, every chip named by its whole tag', () => {
    render(<TagStrip tags={rows} activeTag={null} onToggle={() => {}} />)
    const strip = screen.getByRole('group', { name: /filter by tag/i })
    const names = [...strip.querySelectorAll('button')].map(
      (b) => b.getAttribute('aria-label') ?? b.textContent,
    )
    expect(names).toEqual(['#q3', '#release', '#health:failing', '#health:ok'])
    // The key is a label once, not repeated on every chip.
    expect(strip.textContent).toContain('health')
    expect(screen.getByRole('button', { name: '#health:ok' }).textContent).toContain('ok')
  })

  it('shows what carries a tag as a count the accessible name leaves out', () => {
    render(<TagStrip tags={rows} activeTag={null} onToggle={() => {}} />)
    const chip = screen.getByRole('button', { name: '#health:ok' })
    expect(chip.textContent).toContain('3')
    expect(chip.getAttribute('title')).toBe('1 board, 2 boxes')
    expect(screen.getByRole('button', { name: '#q3' }).getAttribute('title')).toBe(
      '2 documents, 1 board',
    )
  })

  it('the active tag is pressed, and a press toggles through onToggle', () => {
    const onToggle = vi.fn()
    render(<TagStrip tags={rows} activeTag="q3" onToggle={onToggle} />)
    expect(screen.getByRole('button', { name: '#q3' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '#release' }).getAttribute('aria-pressed')).toBe(
      'false',
    )
    fireEvent.click(screen.getByRole('button', { name: '#health:ok' }))
    expect(onToggle).toHaveBeenCalledWith('health:ok')
  })
})
