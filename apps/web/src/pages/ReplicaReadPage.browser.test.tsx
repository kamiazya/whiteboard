/**
 * ADR-0023's offline page over REAL IndexedDB: the replica record's list,
 * markdown bodies (EDITABLE — decision 3's data plane), and spatial
 * canvases (still read-only). What must stay pinned from the read-only
 * era: no index row is ever written, no record is ever minted, and a
 * visit that edits nothing leaves the record byte-identical.
 */
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  readMarkdownBody,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { cleanup, render, screen } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { BrowserWorkspaceDocs } from '../lib/browser-workspace-docs.js'
import { IdbDocumentIndex } from '../lib/idb-document-index.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { focusEditable } from '../test-utils/focus-editable.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { ReplicaReadPage } from './ReplicaReadPage.js'

claimIsolatedWhiteboardDb('replica-read-page')

const DAEMON_WS = '01ARZ3NDEKTSV4RRFFQ69G5FB0'
const DOC_MD = '01ARZ3NDEKTSV4RRFFQ69G5FB1'
const DOC_SP = '01ARZ3NDEKTSV4RRFFQ69G5FB2'
const SYNCED = '2026-09-01T12:00:00.000Z'

async function seedReplica(): Promise<void> {
  const record = new LoroDoc()
  createWorkspaceDocumentAtPath(record, {
    path: 'notes/plan',
    documentId: DOC_MD,
    kind: 'markdown',
  })
  writeMarkdownBody(documentContainers(record, DOC_MD), '# Hello from the cache')
  createWorkspaceDocumentAtPath(record, { path: 'sketch', documentId: DOC_SP, kind: 'spatial' })
  writeSpatialCanvas(documentContainers(record, DOC_SP), {
    nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 120, height: 40, text: 'cached node' }],
    edges: [],
  })
  record.commit()
  await new BrowserWorkspaceDocs().save(DAEMON_WS, record)
}

beforeEach(clearWhiteboardDb)
afterEach(cleanup)

describe('ReplicaReadPage', () => {
  it('lists the replica record and reads a markdown body from it', async () => {
    await seedReplica()
    render(<ReplicaReadPage workspaceId={DAEMON_WS} displayName="Design team" syncedAt={SYNCED} />)
    const banner = await screen.findByTestId('replica-offline-banner')
    expect(banner.textContent).toMatch(/unreachable/i)
    // Decision 3's split, stated where the user reads: markdown edits are
    // taken (and ship later); spatial stays read-only.
    expect(banner.textContent).toMatch(/ship to the daemon/i)
    expect(banner.textContent).toContain('Design team')

    await userEvent.click(await screen.findByText('plan'))
    // Split view: the body appears in BOTH the source pane and the preview.
    expect(await screen.findAllByText(/Hello from the cache/)).toHaveLength(2)
  })

  it('renders a spatial document through the read-only viewer', async () => {
    await seedReplica()
    render(<ReplicaReadPage workspaceId={DAEMON_WS} syncedAt={SYNCED} />)
    await userEvent.click(await screen.findByText('sketch'))
    expect(await screen.findByText(/cached node/)).toBeTruthy()
  })

  it('a missing replica renders as missing, and is NOT minted by the visit', async () => {
    render(<ReplicaReadPage workspaceId={DAEMON_WS} syncedAt={SYNCED} />)
    expect(await screen.findByTestId('replica-missing')).toBeTruthy()
    // `open`, never `create`: the visit must not have materialized a record
    // under the daemon's id — an empty record there would read as the
    // daemon's data being gone.
    expect(await new BrowserWorkspaceDocs().open(DAEMON_WS)).toBeNull()
  })

  it('reading leaves the replica record byte-identical', async () => {
    await seedReplica()
    const before = (await new BrowserWorkspaceDocs().open(DAEMON_WS))!.oplogVersion().encode()
    render(<ReplicaReadPage workspaceId={DAEMON_WS} syncedAt={SYNCED} />)
    await userEvent.click(await screen.findByText('plan'))
    await screen.findAllByText(/Hello from the cache/)
    const after = (await new BrowserWorkspaceDocs().open(DAEMON_WS))!.oplogVersion().encode()
    expect(Array.from(after)).toEqual(Array.from(before))
  })

  it('a markdown edit persists to the replica record, and files no index row', async () => {
    await seedReplica()
    const { unmount } = render(<ReplicaReadPage workspaceId={DAEMON_WS} syncedAt={SYNCED} />)
    await userEvent.click(await screen.findByText('plan'))

    await focusEditable(() => document.querySelector('[contenteditable="true"]'))
    await userEvent.keyboard('{Control>}{End}{/Control} offline addition')
    // Unmount flushes the debounce — the daemon returning swaps this page
    // out, and that moment must not eat the last keystrokes.
    unmount()

    await vi.waitFor(async () => {
      const record = await new BrowserWorkspaceDocs().open(DAEMON_WS)
      expect(readMarkdownBody(documentContainers(record!, DOC_MD))).toContain('offline addition')
    })
    // Decision 3's boundary: a data-plane edit files NOTHING in any index —
    // no phantom document rows under either workspace id.
    await expect(new IdbDocumentIndex().listDocuments({ workspaceId: DAEMON_WS })).rejects.toThrow()
  })
})
