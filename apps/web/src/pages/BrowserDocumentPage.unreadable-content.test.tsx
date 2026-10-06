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
import { cleanup, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IdbDefaultDocumentPointer } from '../lib/browser-document-summary.js'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { FoldingBrowserIndex } from '../lib/folding-browser-index.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { renderPage } from '../test-utils/daemon-page-harness.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import { seedLegacyRow } from '../test-utils/seed-legacy-row.js'
import { seedSyncDocument } from '../test-utils/seed-sync-document.js'
import { BrowserDocumentPage } from './BrowserDocumentPage.js'

const DB = claimIsolatedWhiteboardDb('browserdocumentpage-unreadable-content')

vi.mock('../components/spatial-editor/index.js', () => ({
  // Renders a marker rather than null: "the editor did not render" is the
  // guarantee this file exists for — an unreadable document must not be
  // editable, because the next save would overwrite bytes that are intact —
  // and a null mock makes that unassertable.
  SpatialEditor: () => <div data-testid="mock-spatial-editor" />,
}))

async function seedDocumentWithContent(
  content: { raw: unknown } | { snapshot: Uint8Array },
): Promise<void> {
  const entry = await seedLegacyRow({
    workspaceId: getBrowserWorkspaceId(),
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

    renderPage(<BrowserDocumentPage store={new FoldingBrowserIndex()} />)

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/saved by a newer version/i)
    })
    // The half that protects the document: no editor, so nothing can save
    // over it.
    expect(screen.queryByTestId('mock-spatial-editor')).toBeNull()
    await expectLoggedFailure('startup fold left documents behind')
  })

  it('says the data is corrupt when the bytes are not Loro', async () => {
    // A well-formed record carrying bytes Loro will not import — distinct
    // from `{snapshot: null}`, which is a legitimate document that simply has
    // no snapshot yet.
    await seedDocumentWithContent({ snapshot: new Uint8Array([0xff, 0xfe, 0x00, 0x01]) })

    renderPage(<BrowserDocumentPage store={new FoldingBrowserIndex()} />)

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/could not be read/i)
    })
    expect(screen.queryByTestId('mock-spatial-editor')).toBeNull()
    await expectLoggedFailure('startup fold left documents behind')
  })

  it('stops reporting the failure once a readable document is opened', async () => {
    // The reason is state, and state that nothing clears outlives what it was
    // about. A switch from an unreadable document to a sound one would carry
    // the first one's failure across and turn the second into an error screen.
    const broken = await seedLegacyRow({
      workspaceId: getBrowserWorkspaceId(),
      path: 'broken',
      name: 'Broken',
      kind: 'spatial',
    })
    await seedSyncDocument(broken.documentId, { raw: { v: 99 } }, DB)
    const sound = await seedLegacyRow({
      workspaceId: getBrowserWorkspaceId(),
      path: 'sound',
      name: 'Sound',
      kind: 'spatial',
    })
    await new IdbDefaultDocumentPointer(DB).set(broken.documentId)

    const view = renderPage(<BrowserDocumentPage store={new FoldingBrowserIndex()} />)
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())

    // Reopen at the sound document's path, the way the switcher does.
    view.unmount()
    await new IdbDefaultDocumentPointer(DB).set(sound.documentId)
    renderPage(<BrowserDocumentPage store={new FoldingBrowserIndex()} />)

    await waitFor(() => expect(screen.getByTestId('mock-spatial-editor')).toBeTruthy())
    expect(screen.queryByRole('alert')).toBeNull()
    await expectLoggedFailure('startup fold left documents behind')
  })
})
