/**
 * ADR-0023's offline read over REAL IndexedDB: the page serves the replica
 * record — list, markdown body, spatial canvas — without writing anything.
 * web-browser layer because the record lives in real IndexedDB and the
 * spatial path renders through the real layout pipeline.
 */
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { cleanup, render, screen } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { BrowserWorkspaceDocs } from '../lib/browser-workspace-docs.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
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
    expect(banner.textContent).toMatch(/read-only/i)
    expect(banner.textContent).toContain('Design team')

    await userEvent.click(await screen.findByText('plan'))
    // The preview renders the body as a keyed SVG projection.
    expect(await screen.findByText(/Hello from the cache/)).toBeTruthy()
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
    await screen.findByText(/Hello from the cache/)
    const after = (await new BrowserWorkspaceDocs().open(DAEMON_WS))!.oplogVersion().encode()
    expect(Array.from(after)).toEqual(Array.from(before))
  })
})
