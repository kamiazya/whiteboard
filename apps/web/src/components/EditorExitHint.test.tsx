// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorExitHint } from './EditorExitHint.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function stubPlatform(platform: string) {
  vi.stubGlobal('navigator', { ...window.navigator, platform })
}

describe('EditorExitHint', () => {
  it('names the Mac command glyph on a Mac-family platform', () => {
    stubPlatform('MacIntel')
    render(<EditorExitHint />)
    expect(screen.getByTestId('editor-exit-hint').textContent).toContain('⌘↩')
  })

  it('names Ctrl everywhere else', () => {
    stubPlatform('Win32')
    render(<EditorExitHint />)
    const hint = screen.getByTestId('editor-exit-hint')
    expect(hint.textContent).toContain('Ctrl+↩')
    expect(hint.textContent).not.toContain('⌘')
  })

  it('says both exits, and stays decoration (hidden, no pointer target)', () => {
    stubPlatform('MacIntel')
    render(<EditorExitHint />)
    const hint = screen.getByTestId('editor-exit-hint')
    expect(hint.textContent).toContain('Done')
    expect(hint.textContent).toContain('Cancel')
    expect(hint.getAttribute('aria-hidden')).toBe('true')
    expect(hint.className).toContain('pointer-events-none')
  })
})

/** jsdom has no matchMedia at all, so the fine-pointer cases above see none. */
function stubCoarsePointer() {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(pointer: coarse)' }))
}

describe('EditorExitHint on a coarse pointer', () => {
  it('offers Done and Cancel as real buttons that route to the handlers', () => {
    stubCoarsePointer()
    const onDone = vi.fn()
    const onCancel = vi.fn()
    render(<EditorExitHint onDone={onDone} onCancel={onCancel} />)
    const hint = screen.getByTestId('editor-exit-hint')
    expect(hint.getAttribute('aria-hidden')).toBeNull()
    expect(hint.className).not.toContain('pointer-events-none')
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onCancel).toHaveBeenCalledTimes(1)
    // No chord is named: a finger has none to press. And no words either —
    // the verbs are icons with accessible names, like every other pill.
    expect(hint.querySelector('kbd')).toBeNull()
    expect(hint.textContent?.trim()).toBe('')
    expect(hint.querySelectorAll('svg')).toHaveLength(2)
  })

  it('claims pointerdown so the editor keeps focus until the click lands', () => {
    stubCoarsePointer()
    render(<EditorExitHint onDone={vi.fn()} onCancel={vi.fn()} />)
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true })
    cancel.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('stays the decorative strip when no handler is offered', () => {
    stubCoarsePointer()
    render(<EditorExitHint />)
    expect(screen.getByTestId('editor-exit-hint').getAttribute('aria-hidden')).toBe('true')
  })
})
