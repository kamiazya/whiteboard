// The keyboard-docked formatting bar owns the window's bottom edge while a
// markdown editor holds the caret; the dock sits there too, so showing both
// left the dock half hidden behind the bar.
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '../../index.css'
import {
  type ActiveMarkdownEditor,
  clearActiveMarkdownEditor,
  setActiveMarkdownEditor,
} from '../markdown-editor/active-markdown-editor.js'
import { SpatialEditor } from './SpatialEditor.js'

const realMatchMedia = window.matchMedia
let coarse = true
const editor: ActiveMarkdownEditor = {
  run: vi.fn(),
  headingLevel: () => 0,
  focus: vi.fn(),
  selectedRange: () => null,
}

beforeEach(() => {
  coarse = true
  window.matchMedia = (query: string) =>
    query === '(pointer: coarse)'
      ? ({ matches: coarse, media: query } as MediaQueryList)
      : realMatchMedia.call(window, query)
})

afterEach(() => {
  act(() => clearActiveMarkdownEditor(editor))
  cleanup()
  window.matchMedia = realMatchMedia
})

function dock(): HTMLElement {
  return document.querySelector('[data-testid="tool-palette"]') as HTMLElement
}

function mount() {
  render(
    <div className="relative bg-background" style={{ width: 390, height: 600 }}>
      <SpatialEditor
        defaultTool="select"
        canvas={{ nodes: [], edges: [] }}
        onChange={vi.fn()}
        theme="light"
        fileRefOptions={[]}
      />
    </div>,
  )
}

it('the dock yields to the docked formatting bar and returns when the editor closes', () => {
  mount()
  expect(getComputedStyle(dock()).display).not.toBe('none')
  act(() => setActiveMarkdownEditor(editor))
  expect(getComputedStyle(dock()).display).toBe('none')
  act(() => clearActiveMarkdownEditor(editor))
  expect(getComputedStyle(dock()).display).not.toBe('none')
})

it('the dock stays beside a hardware keyboard, where no bar is docked', () => {
  coarse = false
  mount()
  act(() => setActiveMarkdownEditor(editor))
  expect(getComputedStyle(dock()).display).not.toBe('none')
})
