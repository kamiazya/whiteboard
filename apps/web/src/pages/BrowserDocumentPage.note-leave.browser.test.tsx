/**
 * A brand-new note typed into and left inside the save debounce: the tab is
 * closed, switched away from, or the phone app backgrounded before the edit
 * window has passed. The page's last reliable signals are `visibilitychange`
 * to hidden and `pagehide` (Page Lifecycle API), and the typed text has to be
 * written on them rather than on a timer that may never fire.
 *
 * The debounce timer is faked from before the first keystroke and DISCARDED
 * before the store is read, so the only way the text can reach IndexedDB is
 * the page-leaving flush — a write the timer landed would prove nothing.
 * Real CodeMirror, real IndexedDB; the spatial editor is mocked because this
 * suite's subject is the note's write path.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { BrowserDocumentIndex } from '../lib/browser-document-index.js'
import { listBrowserDocuments } from '../lib/browser-document-summary.js'
import { loadDocumentContent } from '../lib/workspace-content.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import '../index.css'
import { renderPage } from '../test-utils/daemon-page-harness.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedIdbDocument } from '../test-utils/seed-idb-document.js'

claimIsolatedWhiteboardDb('browserdocumentpage-note-leave')

vi.mock('../components/spatial-editor/index.js', () => ({
  SpatialEditor: (_props: { canvas: SpatialCanvas }) => <div data-testid="mock-spatial-editor" />,
}))

const { BrowserDocumentPage } = await import('./BrowserDocumentPage.js')

function hideDocument(): () => void {
  const own = Object.getOwnPropertyDescriptor(document, 'visibilityState')
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
  return () => {
    if (own === undefined) Reflect.deleteProperty(document, 'visibilityState')
    else Object.defineProperty(document, 'visibilityState', own)
  }
}

async function storedBody(store: BrowserDocumentIndex): Promise<string | undefined> {
  const entry = (await listBrowserDocuments(store)).find((row) => row.kind === 'markdown')
  const content = await loadDocumentContent(entry?.documentId ?? '')
  return content?.getText('body').toString()
}

async function typeIntoNewNote(store: BrowserDocumentIndex): Promise<void> {
  await seedIdbDocument({ path: 'note', kind: 'markdown', makeDefault: true })
  renderPage(<BrowserDocumentPage store={store} />)
  const editable = await waitFor(
    () => {
      const el = document.querySelector<HTMLElement>('.cm-content')
      expect(el).not.toBeNull()
      expect(document.activeElement).toBe(el)
      return el as HTMLElement
    },
    { timeout: 30_000 },
  )
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await userEvent.keyboard('Rain falls')
  // `vi.waitFor` keeps the real clock; testing-library's would poll on the faked one.
  await vi.waitFor(() => expect(editable.textContent).toBe('Rain falls'))
}

describe('a new note left inside the save window', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  it('keeps the typed text when the tab is hidden', async () => {
    const store = new BrowserDocumentIndex()
    await typeIntoNewNote(store)
    const restore = hideDocument()
    try {
      document.dispatchEvent(new Event('visibilitychange'))
    } finally {
      restore()
    }
    vi.useRealTimers()
    await vi.waitFor(async () => expect(await storedBody(store)).toBe('Rain falls'), {
      timeout: 10_000,
    })
  })

  it('keeps the typed text on pagehide', async () => {
    const store = new BrowserDocumentIndex()
    await typeIntoNewNote(store)
    window.dispatchEvent(new Event('pagehide'))
    vi.useRealTimers()
    await vi.waitFor(async () => expect(await storedBody(store)).toBe('Rain falls'), {
      timeout: 10_000,
    })
  })
})
