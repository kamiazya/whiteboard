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
  return rtlRender(
    // Pages fill their allotted height (h-full) — the app shell owns the
    // viewport in production, so tests supply the equivalent sized parent.
    <div style={{ height: '100vh' }}>
      <MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>
    </div>,
  )
}

let spatialMounts = 0

vi.mock('../components/spatial-editor/index.js', () => ({
  SpatialEditor: (_props: { canvas: SpatialCanvas }) => {
    spatialMounts += 1
    return <div data-testid="mock-spatial-editor" />
  },
}))

const { BrowserLocalCanvasPage } = await import('./BrowserLocalCanvasPage.js')

/**
 * Waits until the page reports the debounced save as landed.
 *
 * The save is debounced 500ms and then has to reach IndexedDB, so a fixed
 * sleep is a bet on machine speed — the timing-based assertion this repo
 * treats as a recurring flake shape, and what tipped these tests over under
 * load. `Saved` is the page's own report that the write completed, which is
 * the condition these tests actually depend on before tearing the page down.
 */
async function waitForSaved(): Promise<void> {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Saved' })).toBeTruthy(), {
    timeout: 15_000,
  })
}

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
    const switcher = await screen.findByRole(
      'button',
      { name: /^Workspace:/i },
      { timeout: 10_000 },
    )
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
    //
    // The wait checks activeElement IS the CodeMirror contentDOM (.cm-content,
    // same element as `editable`), not merely contained by .cm-editor — that
    // exact identity is what real keyboard-event delivery depends on, and a
    // looser containment check can pass while focus still sits on some other
    // in-flight descendant (e.g. mid-mount) and races the first keystrokes.
    await waitFor(() => {
      expect(document.activeElement).toBe(editable)
    })
    await userEvent.keyboard('# Persisted note')
    await waitFor(() => {
      expect(document.querySelector('.cm-content')?.textContent).toBe('# Persisted note')
    })

    await waitForSaved()
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

  it('a markdown canvas has no display-settings gear — edge routing is spatial-only', async () => {
    const store = new IndexedDBStore()
    render(<BrowserLocalCanvasPage store={store} />)

    // Fresh DB boots into a spatial canvas: the gear is offered there.
    await screen.findByTestId('mock-spatial-editor')
    await waitFor(() => {
      expect(document.querySelector('[data-testid="canvas-settings-button"]')).not.toBeNull()
    })

    const switcher = await screen.findByRole(
      'button',
      { name: /^Workspace:/i },
      { timeout: 10_000 },
    )
    await userEvent.click(switcher)
    await userEvent.click(await screen.findByTestId('new-markdown-menu-item'))
    await waitFor(() => {
      expect(document.querySelector('[contenteditable="true"]')).not.toBeNull()
    })

    // Edge routing has no meaning for a document with no spatial scene —
    // the gear must not carry over; the rest of the canvas row does.
    expect(document.querySelector('[data-testid="canvas-settings-button"]')).toBeNull()
    expect(document.querySelector('[data-testid="save-status-chip"]')).toBeTruthy()
  })

  it('the title survives a remount and renames the canvas in the switcher', async () => {
    const store = new IndexedDBStore()
    const first = render(<BrowserLocalCanvasPage store={store} />)

    await screen.findByTestId('mock-spatial-editor')
    const switcher = await screen.findByRole(
      'button',
      { name: /^Workspace:/i },
      { timeout: 10_000 },
    )
    await userEvent.click(switcher)
    await userEvent.click(await screen.findByTestId('new-markdown-menu-item'))

    const title = await screen.findByRole('textbox', { name: /title/i })
    await userEvent.click(title)
    await userEvent.keyboard('リリース計画')
    await waitFor(() => {
      expect((title as HTMLInputElement).value).toBe('リリース計画')
    })

    // title and the canvas name are one concept: the switcher label is the
    // snapshot row, written from the same edit as the OKF core facet.
    // title and the canvas name are one concept — observed in the switcher's
    // LIST, since its trigger names the workspace rather than the canvas.
    await userEvent.click(await screen.findByRole('button', { name: /^Workspace:/i }))
    // Scoped to the menu item: the title INPUT holds the same string, so a
    // bare text query matches both and cannot tell them apart.
    await screen.findByRole('menuitem', { name: /リリース計画/ }, { timeout: 10_000 })
    await userEvent.keyboard('{Escape}')

    await waitForSaved()
    first.unmount()

    // The facet itself round-trips through the Loro 'core' map, so the
    // title comes back even though the switcher could have supplied a name.
    render(<BrowserLocalCanvasPage store={store} />)
    await waitFor(() => {
      const restored = screen.getByRole('textbox', { name: /title/i }) as HTMLInputElement
      expect(restored.value).toBe('リリース計画')
    })
  })

  it('keeps the body when core facets are written, and vice versa', async () => {
    const store = new IndexedDBStore()
    const first = render(<BrowserLocalCanvasPage store={store} />)

    await screen.findByTestId('mock-spatial-editor')
    const switcher = await screen.findByRole(
      'button',
      { name: /^Workspace:/i },
      { timeout: 10_000 },
    )
    await userEvent.click(switcher)
    await userEvent.click(await screen.findByTestId('new-markdown-menu-item'))

    const editable = await waitFor(() => {
      const el = document.querySelector('[contenteditable="true"]')
      expect(el).not.toBeNull()
      return el as HTMLElement
    })
    // Click-focus (matching every other CodeMirror typing suite in this
    // repo) rather than relying on autofocus: this test's subject is
    // body/facet independence, not the fresh-note autofocus guarantee that
    // test 1 above already pins (see its focus-wait comment for why exact
    // contentDOM identity is required).
    await userEvent.click(editable)
    await waitFor(() => {
      expect(document.activeElement).toBe(editable)
    })
    await userEvent.keyboard('body first')
    await waitFor(() => {
      expect(document.querySelector('.cm-content')?.textContent).toBe('body first')
    })

    // Body and facets are containers of ONE document saved as a whole
    // snapshot; writing facets after the body must not export a document
    // that has lost the body (and the reverse must hold too).
    const title = screen.getByRole('textbox', { name: /title/i })
    await userEvent.click(title)
    await userEvent.keyboard('Titled')

    await waitForSaved()
    first.unmount()

    render(<BrowserLocalCanvasPage store={store} />)
    await waitFor(() => {
      expect(document.querySelector('.cm-content')?.textContent).toContain('body first')
    })
    expect((screen.getByRole('textbox', { name: /title/i }) as HTMLInputElement).value).toBe(
      'Titled',
    )
  })

  it('flushes a title edit that is still debounced when the page goes away', async () => {
    const store = new IndexedDBStore()
    const first = render(<BrowserLocalCanvasPage store={store} />)

    await screen.findByTestId('mock-spatial-editor')
    const switcher = await screen.findByRole(
      'button',
      { name: /^Workspace:/i },
      { timeout: 10_000 },
    )
    await userEvent.click(switcher)
    await userEvent.click(await screen.findByTestId('new-markdown-menu-item'))

    const title = await screen.findByRole('textbox', { name: /title/i })
    await userEvent.click(title)
    await userEvent.keyboard('Fast switch')
    await waitFor(() => {
      expect((title as HTMLInputElement).value).toBe('Fast switch')
    })

    // Unmount INSIDE the save debounce. `renameCanvas` has already written the
    // snapshot name, so a cancelled facet save would leave the list name and
    // the OKF title permanently disagreeing.
    first.unmount()

    render(<BrowserLocalCanvasPage store={store} />)
    await waitFor(() => {
      const restored = screen.getByRole('textbox', { name: /title/i }) as HTMLInputElement
      expect(restored.value).toBe('Fast switch')
    })
  })

  it('a spatial canvas gets the same properties bar, and its title round-trips', async () => {
    const store = new IndexedDBStore()
    await store.setDefaultCanvasId('spatial-1')
    await store.save({
      id: 'spatial-1',
      name: 'Diagram A',
      updatedAt: '2026-05-24T00:00:00.000Z',
      kind: 'spatial' as const,
    })
    const first = render(<BrowserLocalCanvasPage store={store} />)
    await screen.findByTestId('mock-spatial-editor')

    // Facets belong to the CANVAS, so a spatial canvas has the bar too —
    // its document just lives behind the sync session's delta protocol
    // rather than the markdown hook's snapshot save.
    const title = await screen.findByRole('textbox', { name: /title/i }, { timeout: 10_000 })
    // A canvas that predates the facet bar shows its NAME as the title, not
    // an empty box the user would have to retype.
    expect((title as HTMLInputElement).value).toBe('Diagram A')

    await userEvent.click(title)
    await userEvent.keyboard('{Control>}a{/Control}')
    await userEvent.keyboard('Architecture map')
    await userEvent.click(await screen.findByRole('button', { name: /^Workspace:/i }))
    await screen.findByRole('menuitem', { name: /Architecture map/ }, { timeout: 10_000 })
    await userEvent.keyboard('{Escape}')

    await waitForSaved()
    first.unmount()

    render(<BrowserLocalCanvasPage store={store} />)
    await waitFor(
      () => {
        const restored = screen.getByRole('textbox', { name: /title/i }) as HTMLInputElement
        expect(restored.value).toBe('Architecture map')
      },
      { timeout: 10_000 },
    )
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

    const switcher = await screen.findByRole(
      'button',
      { name: /^Workspace:/i },
      { timeout: 10_000 },
    )
    await userEvent.click(switcher)
    await userEvent.click(await screen.findByTestId('new-markdown-menu-item'))
    await waitFor(() => {
      expect(document.querySelector('[contenteditable="true"]')).not.toBeNull()
    })

    // Switch back to the original spatial canvas via the switcher list.
    const before = spatialMounts
    const switcher2 = await screen.findByRole(
      'button',
      { name: /^Workspace:/i },
      { timeout: 10_000 },
    )
    await userEvent.click(switcher2)
    await userEvent.click(await screen.findByText('Diagram A'))

    await waitFor(() => {
      expect(screen.getByTestId('mock-spatial-editor')).toBeInTheDocument()
    })
    expect(spatialMounts).toBeGreaterThan(before)
  })
})
