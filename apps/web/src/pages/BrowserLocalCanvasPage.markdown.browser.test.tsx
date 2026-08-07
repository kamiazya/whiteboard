/**
 * Markdown-canvas 導線 (real IndexedDB + real CodeMirror): create a markdown
 * note through the top bar's "New markdown note…" item, type into the real
 * source pane, and confirm the body survives a full page remount — the Loro
 * 'body' text container persisted through the SAME store the spatial
 * canvases use. SpatialEditor is mocked (this suite's subject is the
 * kind-switch + persistence wiring, not gesture input), but MarkdownEditor
 * is REAL: CodeMirror's input path and Canvas 2D measurement are exactly
 * what jsdom cannot exercise.
 */

import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { IndexedDBStore } from '../lib/browser-local-store.js'
import { clearWhiteboardDb } from '../test-utils/browser-local-canvas.js'
import '../index.css'

function render(ui: ReactElement) {
  return rtlRender(<MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>)
}

let spatialMounts = 0

vi.mock('../components/spatial-editor/index.js', () => ({
  SpatialEditor: (_props: { canvas: SpatialCanvas }) => {
    spatialMounts += 1
    return <div data-testid="mock-spatial-editor" />
  },
}))

const { BrowserLocalCanvasPage } = await import('./BrowserLocalCanvasPage.js')

// The body save is debounced (500ms) inside use-markdown-body; wait past it.
const SAVE_SETTLE_MS = 800

describe('BrowserLocalCanvasPage markdown 導線 (browser — real IndexedDB)', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
    spatialMounts = 0
  })

  afterEach(() => {
    cleanup()
  })

  it('New markdown note… opens the markdown editor; the typed body survives a remount', async () => {
    const store = new IndexedDBStore()
    const first = render(<BrowserLocalCanvasPage store={store} />)

    // Fresh DB boots into a spatial canvas.
    await screen.findByTestId('mock-spatial-editor')

    // Open the switcher dropdown and create a markdown note.
    const switcher = await screen.findByRole('button', { name: 'untitled' }, { timeout: 10_000 })
    await userEvent.click(switcher)
    const newMarkdown = await screen.findByTestId('new-markdown-menu-item')
    await userEvent.click(newMarkdown)

    // The markdown editor (real CodeMirror) replaces the spatial editor.
    const editable = await waitFor(() => {
      const el = document.querySelector('[contenteditable="true"]')
      expect(el).not.toBeNull()
      return el as HTMLElement
    })
    expect(screen.queryByTestId('mock-spatial-editor')).toBeNull()

    // Typing starts the moment the editor appears, with NO click and NO
    // settling wait: a fresh markdown note must be focused for typing
    // immediately, and the dropdown's close-time focus return must never
    // steal keystrokes mid-word (the bug shipped as "type a sentence,
    // only the first three characters persist").
    await waitFor(() => {
      expect(editable.closest('.cm-editor')?.contains(document.activeElement)).toBe(true)
    })
    await userEvent.keyboard('# Persisted note')
    await waitFor(() => {
      expect(document.querySelector('.cm-content')?.textContent).toBe('# Persisted note')
    })

    // Let the debounced Loro save land before tearing the page down.
    await new Promise((resolve) => setTimeout(resolve, SAVE_SETTLE_MS))
    const markdownCanvasId = await store.getDefaultCanvasId()
    expect(markdownCanvasId).not.toBeNull()
    first.unmount()

    // A fresh page against the same store reopens the markdown note with
    // its body restored from the Loro 'body' container.
    render(<BrowserLocalCanvasPage store={store} />)
    await waitFor(() => {
      const content = document.querySelector('.cm-content')
      expect(content?.textContent).toContain('# Persisted note')
    })
    expect(screen.queryByTestId('mock-spatial-editor')).toBeNull()
  })

  it('spatial canvases still open the spatial editor after a markdown note exists', async () => {
    const store = new IndexedDBStore()
    // Distinctly-named spatial canvas so the round trip back to it is
    // unambiguous (the fresh markdown note is also 'untitled').
    await store.setDefaultCanvasId('spatial-1')
    await store.save({
      id: 'spatial-1',
      name: 'Diagram A',
      updatedAt: '2026-05-24T00:00:00.000Z',
      kind: 'spatial' as const,
    })
    render(<BrowserLocalCanvasPage store={store} />)
    await screen.findByTestId('mock-spatial-editor')

    const switcher = await screen.findByRole('button', { name: 'Diagram A' }, { timeout: 10_000 })
    await userEvent.click(switcher)
    await userEvent.click(await screen.findByTestId('new-markdown-menu-item'))
    await waitFor(() => {
      expect(document.querySelector('[contenteditable="true"]')).not.toBeNull()
    })

    // Switch back to the original spatial canvas via the switcher list.
    const before = spatialMounts
    const switcher2 = await screen.findByRole('button', { name: 'untitled' }, { timeout: 10_000 })
    await userEvent.click(switcher2)
    await userEvent.click(await screen.findByText('Diagram A'))

    await waitFor(() => {
      expect(screen.getByTestId('mock-spatial-editor')).toBeInTheDocument()
    })
    expect(spatialMounts).toBeGreaterThan(before)
  })
})
