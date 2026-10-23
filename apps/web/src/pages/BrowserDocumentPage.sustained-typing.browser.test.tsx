import { cleanup, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { FoldingBrowserIndex } from '../lib/folding-browser-index.js'
import { STUCK_AFTER_MS } from '../lib/storage-health.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import '../index.css'
import { renderPage } from '../test-utils/daemon-page-harness.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedIdbDocument } from '../test-utils/seed-idb-document.js'

claimIsolatedWhiteboardDb('browserdocumentpage-sustained-typing')

vi.mock('../components/spatial-editor/index.js', () => ({
  SpatialEditor: () => <div data-testid="mock-spatial-editor" />,
}))

const { BrowserDocumentPage } = await import('./BrowserDocumentPage.js')

const KEYSTROKE_GAP_MS = 100
const tone = () => document.querySelector('[data-testid="save-status"]')?.getAttribute('data-tone')

describe('typing a note without pausing, then creating a note from a link', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
  })
  afterEach(() => {
    cleanup()
  })

  it('never draws a problem while the keystrokes keep coming', async () => {
    const store = new FoldingBrowserIndex()
    await seedIdbDocument({ path: 'note', kind: 'markdown', makeDefault: true })
    renderPage(<BrowserDocumentPage store={store} />)
    const editable = await waitFor(() => {
      const el = document.querySelector('[contenteditable="true"]')
      expect(el).not.toBeNull()
      return el as HTMLElement
    })
    await waitFor(() => expect(document.activeElement).toBe(editable), { timeout: 30_000 })

    const seen = new Set<string>()
    const observer = new MutationObserver(() => {
      const now = tone()
      if (now !== undefined && now !== null) seen.add(now)
    })
    observer.observe(document.body, { attributes: true, subtree: true, childList: true })

    // Longer than a write may stay pending, with no gap long enough for a
    // quiet-period debounce to fire.
    const keystrokes = Math.ceil((STUCK_AFTER_MS + 1_500) / KEYSTROKE_GAP_MS)
    for (let i = 0; i < keystrokes; i++) {
      await userEvent.keyboard('a')
      await new Promise((resolve) => setTimeout(resolve, KEYSTROKE_GAP_MS))
    }
    await userEvent.keyboard(' [[[[Rollback')
    await waitFor(() => expect(document.querySelector('.cm-tooltip-autocomplete')).not.toBeNull(), {
      timeout: 10_000,
    })
    await userEvent.keyboard('{Enter}')
    await waitFor(
      () => {
        expect(document.querySelector('.cm-content')?.textContent).toContain('[[Rollback]]')
        expect(
          document
            .querySelector('[data-testid="persistence-state"]')
            ?.getAttribute('data-save-state'),
        ).toBe('saved')
      },
      { timeout: 15_000 },
    )
    observer.disconnect()

    expect([...seen]).not.toContain('problem')
  })
})
