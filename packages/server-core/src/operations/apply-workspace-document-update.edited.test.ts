/**
 * A workspace update says nothing about which documents it edits, and the
 * keeper still has to know: the edited ones answer to the caller (which
 * checkpoints them) and carry a fresh `updatedAt` (which every listing reads
 * as "last edited"). A transfer — a promotion — carries its documents' own
 * clocks and takes no stamp.
 */
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  MARKDOWN_BODY_KEY,
  readWorkspaceDocuments,
  setWorkspaceDocumentName,
} from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { LiveDocuments, WorkspaceDocuments } from '../server-deps.js'
import { unusedLiveDocuments } from '../test-utils/unused-live-documents.js'
import { unusedWorkspaceDocuments } from '../test-utils/unused-workspace-documents.js'
import { applyWorkspaceDocumentUpdate } from './apply-workspace-document-update.js'

const WS = 'ws-edited'
const NOTE = '01J0000000000000000000N0TE'
const OTHER = '01J00000000000000000000THR'
const CREATED = 1_000

/** A client replica and the daemon's record, both holding two notes stamped at `CREATED`. */
function keeper() {
  const client = new LoroDoc()
  for (const [documentId, path] of [
    [NOTE, 'notes/weekly'],
    [OTHER, 'other'],
  ] as const) {
    createWorkspaceDocumentAtPath(client, {
      path,
      documentId,
      kind: 'markdown',
      createdAt: CREATED,
    })
  }
  client.commit()
  const record = new LoroDoc()
  record.import(client.export({ mode: 'snapshot' }))
  const workspaceDocuments: WorkspaceDocuments = {
    ...unusedWorkspaceDocuments(),
    get: async () => record,
    async save() {},
    evictProjections() {},
  }
  const live: LiveDocuments = {
    ...unusedLiveDocuments(),
    withWriteLock: <T>(_workspaceId: string, fn: () => Promise<T>) => fn(),
  }
  return {
    client,
    deps: { liveDocuments: live, workspaceDocuments },
    updatedAtOf: (documentId: string) =>
      readWorkspaceDocuments(record).find((entry) => entry.documentId === documentId)?.updatedAt,
  }
}

/** What the client sends for whatever `edit` does to its replica. */
function sent(client: LoroDoc, edit: () => void): Uint8Array {
  const from = client.oplogVersion()
  edit()
  client.commit()
  return client.export({ mode: 'update', from }) as Uint8Array
}

const typeInto = (client: LoroDoc, documentId: string) => () => {
  documentContainers(client, documentId).getText(MARKDOWN_BODY_KEY).insert(0, 'typed')
}

describe('applyWorkspaceDocumentUpdate answers and stamps what it edited', () => {
  it('answers each document whose content the update wrote, by id and path', async () => {
    const { client, deps } = keeper()
    const update = sent(client, () => {
      typeInto(client, NOTE)()
      typeInto(client, OTHER)()
    })

    const result = await applyWorkspaceDocumentUpdate(deps, { workspaceId: WS, update })

    expect(result.kind).toBe('applied')
    if (result.kind !== 'applied') return
    expect([...result.edited].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { documentId: NOTE, path: 'notes/weekly' },
      { documentId: OTHER, path: 'other' },
    ])
  })

  it('stamps updatedAt on the edited document, and no other', async () => {
    const { client, deps, updatedAtOf } = keeper()

    await applyWorkspaceDocumentUpdate(deps, {
      workspaceId: WS,
      update: sent(client, typeInto(client, NOTE)),
    })

    expect(updatedAtOf(NOTE)).toBeGreaterThan(CREATED)
    expect(updatedAtOf(OTHER)).toBe(CREATED)
  })

  it('neither answers nor stamps a document the update only renamed', async () => {
    const { client, deps, updatedAtOf } = keeper()
    const update = sent(client, () =>
      setWorkspaceDocumentName(client, { documentId: NOTE, name: 'Weekly' }),
    )

    const result = await applyWorkspaceDocumentUpdate(deps, { workspaceId: WS, update })

    expect(result).toEqual({ kind: 'applied', edited: [] })
    expect(updatedAtOf(NOTE)).toBe(CREATED)
  })

  it('stamps nothing for a transfer, which carries its own clocks', async () => {
    const { client, deps, updatedAtOf } = keeper()

    const result = await applyWorkspaceDocumentUpdate(deps, {
      workspaceId: WS,
      update: sent(client, typeInto(client, NOTE)),
      origin: 'transfer',
    })

    expect(result).toEqual({
      kind: 'applied',
      edited: [{ documentId: NOTE, path: 'notes/weekly' }],
    })
    expect(updatedAtOf(NOTE)).toBe(CREATED)
  })
})
