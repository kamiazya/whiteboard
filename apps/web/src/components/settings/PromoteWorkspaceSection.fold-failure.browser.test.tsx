/**
 * The promote dialog's fold-failure degradation, in its own file: vi.mock is
 * hoisted file-wide, and the positive-path tests next door must exercise the
 * REAL fold — a shared file would put the spy under them too.
 *
 * The decided degradation: a failed fold falls back to exactly the pre-fold
 * view — tree-held documents only, undercounted but OPEN — and never reads
 * as a daemon failure, because it is a storage-side problem. Note the
 * observability asymmetry: an un-called fold and a failed fold are identical
 * at the dialog, so the load-bearing assertion is that the fold was ATTEMPTED
 * (the spy fired); the count and copy assertions pin the degradation shape.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { getBrowserWorkspaceId } from '../../lib/browser-workspace-id.js'
import { foldWorkspaceDocuments } from '../../lib/fold-workspace.js'
import { FoldingBrowserIndex } from '../../lib/folding-browser-index.js'
import { IdbDocumentIndex } from '../../lib/idb-document-index.js'
import { ensureLocalWorkspace } from '../../lib/local-document-summary.js'
import { LoroStore } from '../../lib/loro-store.js'
import { createUserSettingsStore, STORAGE_KEY } from '../../lib/user-settings-store.js'
import { clearWhiteboardDb } from '../../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../../test-utils/isolated-whiteboard-db.js'
import { PromoteWorkspaceSection } from './PromoteWorkspaceSection.js'

vi.mock('../../lib/fold-workspace.js', { spy: true })

claimIsolatedWhiteboardDb('promote-fold-failure')

const DAEMON = { baseUrl: 'http://127.0.0.1:3099', token: 'tok-1' }

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
  vi.mocked(foldWorkspaceDocuments).mockClear()
})
afterEach(cleanup)

describe('PromoteWorkspaceSection under a failing fold', () => {
  it('attempts the fold, degrades to the tree-held count, never claims a daemon failure', async () => {
    // One document each side of the fold: tree-held (survives a failed fold)
    // and a pre-fold legacy record (only a successful fold would carry it).
    const tree = new FoldingBrowserIndex()
    await ensureLocalWorkspace(tree)
    await tree.createDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'held',
      kind: 'markdown',
    })
    const legacy = new IdbDocumentIndex()
    // `legacy` is the row-plane index, whose `WORKSPACES_STORE` row `tree`'s
    // `ensureLocalWorkspace` above never wrote — that call went through the
    // tree-backed `FoldingBrowserIndex`, which registers a workspace as a
    // `workspace-tree:<id>` sync record instead. The row-plane index has its
    // own registry and needs it seeded explicitly.
    await ensureLocalWorkspace(legacy)
    const entry = await legacy.createDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'legacy-only',
      kind: 'spatial',
    })
    const doc = new LoroDoc()
    doc.getMap('nodes').set('n1', { id: 'n1', type: 'text', x: 0, y: 0, width: 8, height: 4 })
    doc.commit()
    await new LoroStore().save(entry.documentId, doc.export({ mode: 'snapshot' }))

    // The seeding above runs the real (spied) fold via FoldingBrowserIndex;
    // only the component's own call is under test.
    vi.mocked(foldWorkspaceDocuments).mockClear()
    vi.mocked(foldWorkspaceDocuments).mockRejectedValueOnce(new Error('injected fold failure'))

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
    // ...the fold was attempted exactly once (an un-called fold shows the
    // same dialog, which is why this assertion carries the test)...
    expect(vi.mocked(foldWorkspaceDocuments)).toHaveBeenCalledTimes(1)
    // ...the count is the pre-fold degradation value: the tree-held document
    // alone, the legacy record left behind by the failed fold...
    expect(dialog.textContent).toMatch(/all 1 document\b/i)
    // ...and nothing blames the daemon for a storage-side failure.
    expect(screen.queryByTestId('promote-unavailable')).toBeNull()
    expect(document.body.textContent).not.toMatch(/could not reach the daemon/i)
  })
})
