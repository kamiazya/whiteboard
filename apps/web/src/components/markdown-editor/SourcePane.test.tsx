import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SourcePane } from './SourcePane.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function stubCoarsePointer() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(pointer: coarse)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

function leaveHint(container: HTMLElement): string {
  const hintId = container.querySelector('.cm-content')?.getAttribute('aria-describedby')
  return document.getElementById(hintId as string)?.textContent ?? ''
}

describe('SourcePane', () => {
  it('renders the given value as the CodeMirror document text', () => {
    const { container } = render(<SourcePane value="# Hello" onChange={() => {}} />)
    expect(container.textContent).toContain('Hello')
  })

  it('re-renders with a new external value without mutating the original string', () => {
    const original = '# Hello'
    const onChange = vi.fn()
    const { container, rerender } = render(<SourcePane value={original} onChange={onChange} />)
    rerender(<SourcePane value="# Updated" onChange={onChange} />)
    expect(container.textContent).toContain('Updated')
    expect(original).toBe('# Hello')
  })

  it('unmounts cleanly, destroying the underlying EditorView with no error', () => {
    const { unmount } = render(<SourcePane value="content" onChange={() => {}} />)
    expect(() => unmount()).not.toThrow()
  })

  it('tells a keyboard user how to leave, since Tab indents inside the editor', () => {
    const { container } = render(<SourcePane value="note" onChange={() => {}} />)
    const content = container.querySelector('.cm-content')
    const hintId = content?.getAttribute('aria-describedby')
    expect(hintId).toBeTruthy()
    expect(document.getElementById(hintId as string)?.textContent).toMatch(/Escape.*Tab/)
  })

  // On a phone the words name keys nobody has; a keyboard attached to a
  // touch device is noticed by its first key press, and the hint returns.
  it('keeps the keyboard hint silent on a touch screen until a key is pressed', () => {
    stubCoarsePointer()
    const { container } = render(<SourcePane value="note" onChange={() => {}} />)
    expect(leaveHint(container)).toBe('')

    fireEvent.keyDown(container.querySelector('.cm-content') as HTMLElement, { key: 'Tab' })
    expect(leaveHint(container)).toMatch(/Escape.*Tab/)
  })
})
