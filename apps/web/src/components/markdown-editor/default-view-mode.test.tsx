import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MarkdownEditor } from './MarkdownEditor.js'

beforeEach(() => window.localStorage.clear())
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// CodeMirror also subscribes to a print query, hence the listener methods.
const coarseScreen = () =>
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(pointer: coarse)',
    media: query,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  }))

const mount = () =>
  render(<MarkdownEditor value="text" onChange={vi.fn()} theme="light" onComposeThread={vi.fn()} />)

it('opens in Write on a finger-driven screen, so rotating cannot turn it into Split', () => {
  coarseScreen()
  expect(mount().queryByTestId('markdown-split-divider')).toBeNull()
})

it('still opens in Split on a fine pointer when nothing was chosen', () => {
  expect(mount().getByTestId('markdown-split-divider')).toBeTruthy()
})

it('honours a stored Split choice even on a finger-driven screen', () => {
  window.localStorage.setItem('whiteboard.markdown-view-mode', 'split')
  coarseScreen()
  expect(mount().getByTestId('markdown-split-divider')).toBeTruthy()
})
