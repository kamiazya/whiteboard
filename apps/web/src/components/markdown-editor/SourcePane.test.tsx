import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SourcePane } from './SourcePane.js'

afterEach(() => {
  cleanup()
})

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
})
