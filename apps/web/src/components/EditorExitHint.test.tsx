// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
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
