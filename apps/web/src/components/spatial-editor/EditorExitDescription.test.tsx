import { render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { EditorExitDescription } from './EditorExitDescription.js'

afterEach(() => vi.unstubAllGlobals())

const coarse = () =>
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(pointer: coarse)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))

const described = () => document.getElementById('hint')?.textContent

it('on a touch screen names the two buttons, not keys a phone has none of', () => {
  coarse()
  const { rerender } = render(<EditorExitDescription id="hint" />)
  expect(described()).toBe('✓ Done keeps, ✕ Cancel discards')
  rerender(<EditorExitDescription id="hint" escapeKeeps />)
  expect(described()).toBe('✓ Done or ✕ Cancel keeps the note')
})

it('with a mouse names the keys', () => {
  render(<EditorExitDescription id="hint" />)
  expect(described()).toMatch(/^Escape discards, (Ctrl|Command)\+Enter keeps$/)
})
