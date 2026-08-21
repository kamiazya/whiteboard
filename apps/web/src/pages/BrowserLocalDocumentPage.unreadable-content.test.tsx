/**
 * A document whose stored content this build cannot read must SAY so.
 *
 * `LoroStore.load` classifies it — `unsupported-version` for an envelope from
 * a newer build, `corrupt-snapshot` for bytes that will not import — and the
 * backend forwards the classification. What this file pins is the last leg:
 * that it reaches the screen. Without it a user whose document is intact but
 * unreadable by THIS build is shown an empty canvas, which says their work is
 * gone.
 */
import 'fake-indexeddb/auto'
import { cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IdbDocumentIndex } from '../lib/idb-document-index.js'
import { ensureLocalWorkspace, IdbDefaultDocumentPointer } from '../lib/local-document-summary.js'
import { clearWhiteboardDb } from '../test-utils/browser-local-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedSyncDocument } from '../test-utils/seed-sync-document.js'
import { BrowserLocalDocumentPage } from './BrowserLocalDocumentPage.js'

const DB = claimIsolatedWhiteboardDb('browserlocaldocumentpage-unreadable-content')

vi.mock('../components/spatial-editor/index.js', () => ({
  SpatialEditor: () => null,
}))

function render(ui: ReactElement): ReturnType<typeof rtlRender> {
  return rtlRender(
    <div style={{ height: '100vh' }}>
      <MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>
    </div>,
  )
}

async function seedDocumentWithContent(
  content: { raw: unknown } | { snapshot: Uint8Array },
): Promise<void> {
  const index = new IdbDocumentIndex()
  await ensureLocalWorkspace(index)
  const entry = await index.createDocument({
    workspaceId: 'local',
    path: 'unreadable',
    name: 'Unreadable',
    kind: 'spatial',
  })
  await seedSyncDocument(entry.documentId, content, DB)
  await new IdbDefaultDocumentPointer(DB).set(entry.documentId)
}

describe('a document this build cannot read', () => {
  beforeEach(clearWhiteboardDb)
  afterEach(cleanup)

  it('says the storage version is unsupported rather than showing an empty canvas', async () => {
    await seedDocumentWithContent({ raw: { v: 99, writtenByANewerBuild: true } })

    render(<BrowserLocalDocumentPage store={new IdbDocumentIndex()} />)

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/saved by a newer version/i)
    })
  })

  it('says the data is corrupt when the bytes are not Loro', async () => {
    // A well-formed record carrying bytes Loro will not import — distinct
    // from `{snapshot: null}`, which is a legitimate document that simply has
    // no snapshot yet.
    await seedDocumentWithContent({ snapshot: new Uint8Array([0xff, 0xfe, 0x00, 0x01]) })

    render(<BrowserLocalDocumentPage store={new IdbDocumentIndex()} />)

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/could not be read/i)
    })
  })
})
