/**
 * A board embedded in a note is the same board, so the note's preview colours
 * it by the workspace's tag library exactly as the canvas does (ADR-0040
 * decision 5). Real IndexedDB and a real CodeMirror, because the library is
 * read by the keeper's files source and reaches the preview through the
 * page — the wiring this pins. SpatialEditor is mocked: no board is opened.
 */
import { writeFacets, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { TAG_LIBRARY_PATH, VISUAL_TAGS_KEY } from '@kamiazya/whiteboard-plugin-visual'
import { cleanup, waitFor } from '@testing-library/react'
import { Loro } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { FoldingBrowserIndex } from '../lib/folding-browser-index.js'
import { LoroStore } from '../lib/loro-store.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import '../index.css'
import { renderPage } from '../test-utils/daemon-page-harness.js'
import { focusEditable } from '../test-utils/focus-editable.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedIdbDocument } from '../test-utils/seed-idb-document.js'

claimIsolatedWhiteboardDb('browserdocumentpage-tag-colours')

vi.mock('../components/spatial-editor/index.js', () => ({
  SpatialEditor: () => <div data-testid="mock-spatial-editor" />,
}))

const { BrowserDocumentPage } = await import('./BrowserDocumentPage.js')

async function seedSnapshot(documentId: string, write: (doc: Loro) => void): Promise<void> {
  const doc = new Loro()
  write(doc)
  await new LoroStore().save(documentId, doc.export({ mode: 'snapshot' }))
}

describe('BrowserDocumentPage tag colours in a note', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
  })
  afterEach(() => {
    cleanup()
  })

  it('draws an embedded board in the colours the tag library declares', async () => {
    const BOARD_ID = await seedIdbDocument({ path: 'tagged-board', name: 'Tagged' })
    const TAGS_ID = await seedIdbDocument({ path: TAG_LIBRARY_PATH, kind: 'markdown' })
    await seedIdbDocument({ path: 'embed-source', kind: 'markdown', makeDefault: true })
    await seedSnapshot(BOARD_ID, (doc) =>
      writeSpatialCanvas(doc, {
        nodes: [
          textNode({
            id: 'db',
            x: 0,
            y: 0,
            width: 300,
            height: 120,
            text: 'db',
            tags: ['health:failing'],
          }),
        ],
        edges: [],
      }),
    )
    await seedSnapshot(TAGS_ID, (doc) =>
      writeFacets(doc, {
        [VISUAL_TAGS_KEY]: { keys: { health: { values: { failing: { color: '1' } } } } },
      }),
    )
    renderPage(<BrowserDocumentPage store={new FoldingBrowserIndex()} />)

    await focusEditable(() => document.querySelector('[contenteditable="true"]'))
    await userEvent.keyboard(`![[[[${BOARD_ID}]]{Enter}`)
    // The box tagged `health:failing` takes preset 1's fill, as on the canvas.
    await waitFor(
      () => {
        const preview = document.querySelector('[data-testid="markdown-preview-pane"]')
        expect(preview?.textContent).toContain('Tagged')
        expect(preview?.innerHTML).toContain('#fee2e2')
      },
      { timeout: 10_000 },
    )
  })
})
