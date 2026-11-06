/**
 * A picture pasted into a browser-kept note, end to end: the page hands the
 * editor the browser keeper's own file seam, the file lands in the document
 * file store under the reference the body names, and the preview draws it.
 * The editor's intake on its own is note-image.browser.test.tsx; this is the
 * page wiring nothing else would notice missing.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BrowserDocumentIndex } from '../lib/browser-document-index.js'
import { DocumentFileStore } from '../lib/document-file-store.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import '../index.css'
import { renderPage } from '../test-utils/daemon-page-harness.js'
import { focusEditable } from '../test-utils/focus-editable.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedIdbDocument } from '../test-utils/seed-idb-document.js'

claimIsolatedWhiteboardDb('browserdocumentpage-note-image')

vi.mock('../components/spatial-editor/index.js', () => ({
  SpatialEditor: (_props: { canvas: SpatialCanvas }) => <div data-testid="mock-spatial-editor" />,
}))

const { BrowserDocumentPage } = await import('./BrowserDocumentPage.js')

beforeEach(clearWhiteboardDb)
afterEach(cleanup)

it('stores a pasted image with the browser keeper and draws it in the note', async () => {
  await seedIdbDocument({ path: 'site', kind: 'markdown', makeDefault: true })
  renderPage(<BrowserDocumentPage store={new BrowserDocumentIndex()} />)
  const editable = () => document.querySelector<HTMLElement>('.cm-content')
  await focusEditable(editable)

  const clipboardData = new DataTransfer()
  clipboardData.items.add(
    new File([new Uint8Array([137, 80, 78, 71])], 'meter.png', { type: 'image/png' }),
  )
  fireEvent(
    editable() as HTMLElement,
    new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }),
  )

  const ref = await vi.waitFor(
    () => {
      const found = editable()?.textContent?.match(/!\[meter\]\((asset:[^)]+)\)/)
      expect(found).not.toBeNull()
      return found?.[1] as string
    },
    { timeout: 10_000 },
  )
  const read = await new DocumentFileStore().read(ref)
  expect(read.kind).toBe('blob')
  await vi.waitFor(
    () => {
      const hrefs = [...document.querySelectorAll('[data-testid="markdown-preview-pane"] image')]
      expect(hrefs.some((node) => node.getAttribute('href')?.startsWith('blob:'))).toBe(true)
    },
    { timeout: 10_000 },
  )
})
