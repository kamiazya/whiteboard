import { cleanup, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { BrowserDocumentIndex } from '../lib/browser-document-index.js'
import { clearWhiteboardDb, persistedMarkdownBody } from '../test-utils/browser-document.js'
import '../index.css'
import { renderPage } from '../test-utils/daemon-page-harness.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedIdbDocument } from '../test-utils/seed-idb-document.js'

claimIsolatedWhiteboardDb('browserdocumentpage-undo-outside-editor')

vi.mock('../components/spatial-editor/index.js', () => ({
  SpatialEditor: () => <div data-testid="mock-spatial-editor" />,
}))

const { BrowserDocumentPage } = await import('./BrowserDocumentPage.js')

const saveState = () =>
  document.querySelector('[data-testid="persistence-state"]')?.getAttribute('data-save-state')

/** The editor's text, without the placeholder an empty body shows. */
function editorText(): string | undefined {
  const content = document.querySelector('.cm-content')?.cloneNode(true) as HTMLElement | undefined
  content?.querySelectorAll('.cm-placeholder').forEach((el) => {
    el.remove()
  })
  return content?.textContent ?? undefined
}

describe('undo pressed outside the note editor inside the write window', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
  })
  afterEach(() => {
    cleanup()
  })

  it('leaves the editor, the saved state and the keeper holding the same body', async () => {
    const store = new BrowserDocumentIndex()
    const documentId = await seedIdbDocument({ path: 'note', kind: 'markdown', makeDefault: true })
    renderPage(<BrowserDocumentPage store={store} />)
    const editable = await waitFor(() => {
      const el = document.querySelector('[contenteditable="true"]')
      expect(el).not.toBeNull()
      return el as HTMLElement
    })
    await waitFor(() => expect(document.activeElement).toBe(editable), { timeout: 30_000 })

    await userEvent.keyboard('bbb')
    await waitFor(() => expect(editorText()).toBe('bbb'))
    // Focus leaves the editor, so the press reaches the session's window handler.
    await userEvent.click(document.body)
    await userEvent.keyboard('{Control>}z{/Control}')

    await waitFor(
      async () => {
        expect(editorText()).toBe(await persistedMarkdownBody(documentId))
        expect(saveState()).toBe('saved')
      },
      { timeout: 10_000 },
    )
    expect(editorText()).toBe('')
  })
})
