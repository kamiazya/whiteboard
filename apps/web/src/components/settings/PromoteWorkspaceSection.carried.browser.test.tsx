/**
 * The move's demote gate over what travels BESIDE the record: a workspace
 * with a trashed document and a labelled saved version loses its browser copy
 * only once the daemon confirms holding both, and the report names the daemon
 * workspace by its display name.
 *
 * web-browser because the seeded workspace, its trash bytes and its version
 * rows live in real IndexedDB, read by the production path.
 */

import type { PromoteWorkspaceRequest } from '@kamiazya/whiteboard-daemon-client/api-contracts/promotion'
import { forgetAllForTests } from '@kamiazya/whiteboard-daemon-client/replica-session-key'
import { readWorkspaceDocuments, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { base64UrlToBytes } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render, screen } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { ensureBrowserWorkspace } from '../../lib/browser-document-summary.js'
import { BrowserVersionStore } from '../../lib/browser-version-store.js'
import { BrowserWorkspaceDocs } from '../../lib/browser-workspace-docs.js'
import { getBrowserWorkspaceId } from '../../lib/browser-workspace-id.js'
import { FoldingBrowserIndex } from '../../lib/folding-browser-index.js'
import { connectReplicaKeeper } from '../../lib/replica-store.js'
import { createUserSettingsStore, STORAGE_KEY } from '../../lib/user-settings-store.js'
import { clearWhiteboardDb } from '../../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../../test-utils/isolated-whiteboard-db.js'
import { replicaKeyBody } from '../../test-utils/replica-key-fetch.js'
import { seedWorkspaceDocumentContent } from '../../test-utils/seed-workspace-content.js'
import { PromoteWorkspaceSection } from './PromoteWorkspaceSection.js'

claimIsolatedWhiteboardDb('promote-section-carried')

const BASE = 'http://127.0.0.1:3099'
const DAEMON = { baseUrl: BASE }

/**
 * The daemon routes the move touches. The promote POST merges the posted
 * record into `target` and, when `confirms`, answers that it holds every
 * trash entry and version the body carried — what the real route reads back.
 */
function daemonStub(target: LoroDoc, confirms: boolean) {
  const promotes: PromoteWorkspaceRequest[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    if (url.endsWith('/replica-key') && method === 'POST') {
      return Response.json(replicaKeyBody())
    }
    if (url.endsWith('/api/workspaces') && method === 'GET') {
      return Response.json({ workspaces: [{ workspaceId: 'ws-a', displayName: 'Team notes' }] })
    }
    if (url.endsWith('/workspace-document/promote') && method === 'POST') {
      const body = JSON.parse(init?.body as string) as PromoteWorkspaceRequest
      promotes.push(body)
      target.import(base64UrlToBytes(body.snapshot) as Uint8Array)
      return Response.json({
        ok: true,
        recorded: readWorkspaceDocuments(target).map((entry) => entry.documentId),
        shadowed: [],
        trashStored: confirms ? (body.trash ?? []).map((each) => each.documentId) : [],
        versionsKept: confirms ? (body.versions ?? []).map((each) => each.id) : [],
      })
    }
    if (url.endsWith('/workspace-document/snapshot') && method === 'GET') {
      return new Response(target.export({ mode: 'snapshot' }) as BodyInit, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      })
    }
    if (url.endsWith('/documents')) return Response.json({ documents: [] })
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof globalThis.fetch
  connectReplicaKeeper({ baseUrl: BASE, fetch: fetchImpl })
  return { fetch: fetchImpl, promotes }
}

/** A canvas with a labelled saved version, and a second canvas in the Trash. */
async function seedVersionAndTrash(): Promise<void> {
  const index = new FoldingBrowserIndex()
  await ensureBrowserWorkspace(index)
  const workspaceId = getBrowserWorkspaceId()
  const sketch = await index.createDocument({ workspaceId, path: 'sketch', kind: 'spatial' })
  await index.createDocument({ workspaceId, path: 'gone', kind: 'spatial' })
  const content = new LoroDoc()
  writeCanvasText(content, 'as drafted')
  expect(
    await seedWorkspaceDocumentContent(
      sketch.documentId,
      new Uint8Array(content.export({ mode: 'snapshot' })),
    ),
  ).toBe(true)
  await new BrowserVersionStore({ docs: new BrowserWorkspaceDocs(), index }).save(
    workspaceId,
    'sketch',
    { label: 'as drafted' },
  )
  await index.deleteDocument({ workspaceId, path: 'gone' })
}

function writeCanvasText(doc: LoroDoc, text: string): void {
  writeSpatialCanvas(doc, {
    nodes: [textNode({ id: 'n1', x: 0, y: 0, width: 80, height: 40, text })],
    edges: [],
  })
}

async function moveTo(fetchImpl: typeof globalThis.fetch): Promise<HTMLElement> {
  render(
    <PromoteWorkspaceSection
      daemon={DAEMON}
      settingsStore={createUserSettingsStore()}
      baseFetch={fetchImpl}
      reload={vi.fn()}
    />,
  )
  await userEvent.click(screen.getByTestId('promote-workspace-open'))
  await userEvent.click(await screen.findByTestId('promote-confirm'))
  return screen.findByTestId('promote-last-result')
}

beforeEach(async () => {
  localStorage.removeItem(STORAGE_KEY)
  await clearWhiteboardDb()
})

afterEach(() => {
  cleanup()
  connectReplicaKeeper(null)
  forgetAllForTests()
  vi.restoreAllMocks()
})

describe('PromoteWorkspaceSection, the trash and saved versions', () => {
  it('carries a labelled version and the trash, and removes the copy once the daemon holds both', async () => {
    await seedVersionAndTrash()
    const sourceId = getBrowserWorkspaceId()
    const daemon = daemonStub(new LoroDoc(), true)
    const result = await moveTo(daemon.fetch)

    expect(daemon.promotes[0]?.versions?.map((each) => each.label)).toEqual(['as drafted'])
    expect(daemon.promotes[0]?.trash).toHaveLength(1)
    expect(result.textContent).toMatch(/to daemon workspace "Team notes"/)
    expect(result.textContent).toMatch(/browser copy was removed/i)
    expect(await new BrowserWorkspaceDocs().open(sourceId)).toBeNull()
  })

  it('keeps the browser copy, and says why, while the daemon has not confirmed the trash and versions', async () => {
    await seedVersionAndTrash()
    const sourceId = getBrowserWorkspaceId()
    const result = await moveTo(daemonStub(new LoroDoc(), false).fetch)

    expect(result.textContent).toMatch(/1 trashed document did not reach the daemon/)
    expect(result.textContent).toMatch(/1 saved version did not reach the daemon/)
    expect(result.textContent).toMatch(/original copy is kept in this browser/i)
    expect(await new BrowserWorkspaceDocs().open(sourceId)).not.toBeNull()
    const promotion = createUserSettingsStore().load().migration.promotion
    if (promotion?.ok !== true) throw new Error('expected an ok promotion record')
    expect(promotion.localCopyRemoved).toBe(false)
  })

  it('still says why the browser copy was kept on a later visit, from the stored result', async () => {
    await seedVersionAndTrash()
    await moveTo(daemonStub(new LoroDoc(), false).fetch)
    cleanup()
    render(
      <PromoteWorkspaceSection
        daemon={DAEMON}
        settingsStore={createUserSettingsStore()}
        baseFetch={daemonStub(new LoroDoc(), false).fetch}
        reload={vi.fn()}
      />,
    )
    const result = await screen.findByTestId('promote-last-result')
    expect(result.textContent).toMatch(/1 trashed document did not reach the daemon/)
    expect(result.textContent).toMatch(/1 saved version did not reach the daemon/)
  })
})
