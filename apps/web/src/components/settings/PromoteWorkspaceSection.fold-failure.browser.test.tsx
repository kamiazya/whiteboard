/**
 * The promote dialog's fold-failure degradation, in its own file so the
 * injected failure cannot reach the positive-path tests next door, which
 * must exercise the REAL fold.
 *
 * The decided degradation: a failed fold falls back to exactly the pre-fold
 * view — tree-held documents only, undercounted but OPEN — and never reads
 * as a daemon failure, because it is a storage-side problem. Note the
 * observability asymmetry: an un-called fold and a failed fold are identical
 * at the dialog, so the load-bearing assertion is that the fold was ATTEMPTED
 * and failed under this surface's name (the log record); the count and copy
 * assertions pin the degradation shape.
 */
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render, screen } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { ensureBrowserWorkspace } from '../../lib/browser-document-summary.js'
import { getBrowserWorkspaceId } from '../../lib/browser-workspace-id.js'
import { FoldingBrowserIndex } from '../../lib/folding-browser-index.js'
import { IdbDocumentIndex } from '../../lib/idb-document-index.js'
import { LoroStore } from '../../lib/loro-store.js'
import { createUserSettingsStore, STORAGE_KEY } from '../../lib/user-settings-store.js'
import { clearWhiteboardDb } from '../../test-utils/browser-document.js'
import { expectLoggedFailures } from '../../test-utils/browser-setup.js'
import { claimIsolatedWhiteboardDb } from '../../test-utils/isolated-whiteboard-db.js'
import { PromoteWorkspaceSection } from './PromoteWorkspaceSection.js'

claimIsolatedWhiteboardDb('promote-fold-failure')

const DAEMON = { baseUrl: 'http://127.0.0.1:3099' }

/** Only the workspace listing — the scenario never reaches the transfer. */
const listOnlyStub = (async (input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : input.toString()
  if (url.endsWith('/api/workspaces')) {
    return Response.json({ workspaces: [{ workspaceId: 'ws-a' }] })
  }
  throw new Error(`unexpected fetch: ${url}`)
}) as typeof globalThis.fetch

beforeEach(async () => {
  localStorage.removeItem(STORAGE_KEY)
  await clearWhiteboardDb()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('PromoteWorkspaceSection under a failing fold', () => {
  it('attempts the fold, degrades to the tree-held count, never claims a daemon failure', async () => {
    const logged = expectLoggedFailures()
    // One document each side of the fold: tree-held (survives a failed fold)
    // and a pre-fold legacy record (only a successful fold would carry it).
    const tree = new FoldingBrowserIndex()
    await ensureBrowserWorkspace(tree)
    await tree.createDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'held',
      kind: 'markdown',
    })
    const legacy = new IdbDocumentIndex()
    // `legacy` is the row-plane index, whose `WORKSPACES_STORE` row `tree`'s
    // `ensureBrowserWorkspace` above never wrote — that call went through the
    // tree-backed `FoldingBrowserIndex`, which registers a workspace as a
    // `workspace-tree:<id>` sync record instead. The row-plane index has its
    // own registry and needs it seeded explicitly.
    await ensureBrowserWorkspace(legacy)
    const entry = await legacy.createDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'legacy-only',
      kind: 'spatial',
    })
    const doc = new LoroDoc()
    doc.getMap('nodes').set('n1', textNode({ id: 'n1', x: 0, y: 0, width: 8, height: 4, text: '' }))
    doc.commit()
    await new LoroStore().save(entry.documentId, doc.export({ mode: 'snapshot' }))

    // The seeding above ran the real fold through FoldingBrowserIndex; the
    // component's own run is the next to read the legacy rows, and fails.
    vi.spyOn(IdbDocumentIndex.prototype, 'listDocuments').mockRejectedValueOnce(
      new Error('injected fold failure'),
    )

    render(
      <PromoteWorkspaceSection
        daemon={DAEMON}
        settingsStore={createUserSettingsStore()}
        baseFetch={listOnlyStub}
        reload={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByTestId('promote-workspace-open'))

    // The flow reaches the confirmation, not a stuck or error state...
    const dialog = await screen.findByTestId('promote-dialog')
    // ...the count is the pre-fold degradation value: the tree-held document
    // alone, the legacy record left behind by the failed fold...
    expect(dialog.textContent).toMatch(/all 1 document\b/i)
    // ...and nothing blames the daemon for a storage-side failure.
    expect(screen.queryByTestId('promote-unavailable')).toBeNull()
    expect(document.body.textContent).not.toMatch(/could not reach the daemon/i)
    // ...and the fold was attempted, and failed, under this surface's name
    // (an un-called fold shows the same dialog, which is why this assertion
    // carries the test).
    expect(logged.join('\n')).toContain('[promote-workspace-section] startup fold failed')
  })
})
