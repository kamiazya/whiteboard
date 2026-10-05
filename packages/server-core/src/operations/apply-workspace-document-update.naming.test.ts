/**
 * A note kept by the daemon is named after its heading the same way one kept
 * by the browser is: the browser seeds the name in its own store's write, and
 * this is the daemon's write of the same bytes. Without it a daemon-kept note
 * typed into at `untitled` keeps that name in the card, the URL and every
 * search result.
 */
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  MARKDOWN_BODY_KEY,
  readWorkspaceDocuments,
} from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { LiveDocuments, WorkspaceDocuments } from '../server-deps.js'
import { unusedLiveDocuments } from '../test-utils/unused-live-documents.js'
import { unusedWorkspaceDocuments } from '../test-utils/unused-workspace-documents.js'
import { applyWorkspaceDocumentUpdate } from './apply-workspace-document-update.js'

const WS = 'ws-naming'
const NOTE = '01J0000000000000000000N0TE'
const OTHER = '01J00000000000000000000THR'

interface Seed {
  readonly documentId: string
  readonly path: string
  readonly name?: string
  readonly body?: string
}

/** A client replica and the daemon's record, both holding `seeds`. */
function keeperWith(seeds: readonly Seed[]) {
  const client = new LoroDoc()
  for (const { documentId, path, name, body } of seeds) {
    createWorkspaceDocumentAtPath(client, {
      path,
      documentId,
      kind: 'markdown',
      ...(name === undefined ? {} : { name }),
    })
    if (body !== undefined)
      documentContainers(client, documentId).getText(MARKDOWN_BODY_KEY).insert(0, body)
  }
  client.commit()
  const record = new LoroDoc()
  record.import(client.export({ mode: 'snapshot' }))
  const saved: string[] = []
  const workspaceDocuments: WorkspaceDocuments = {
    ...unusedWorkspaceDocuments(),
    get: async () => record,
    async save(_workspaceId, doc) {
      saved.push(JSON.stringify(readWorkspaceDocuments(doc).map((entry) => entry.name ?? null)))
    },
    evictProjections() {},
  }
  const live: LiveDocuments = {
    ...unusedLiveDocuments(),
    withWriteLock: <T>(_workspaceId: string, fn: () => Promise<T>) => fn(),
  }
  return {
    client,
    record,
    saved,
    deps: { liveDocuments: live, workspaceDocuments },
    nameOf: (documentId: string) =>
      readWorkspaceDocuments(record).find((entry) => entry.documentId === documentId)?.name,
  }
}

/** What the client's editor sends for typing `text` at the start of a note's body. */
function typed(client: LoroDoc, documentId: string, text: string): Uint8Array {
  const from = client.oplogVersion()
  documentContainers(client, documentId).getText(MARKDOWN_BODY_KEY).insert(0, text)
  client.commit()
  return client.export({ mode: 'update', from }) as Uint8Array
}

describe('applyWorkspaceDocumentUpdate names a note after its heading', () => {
  it('names an unnamed note at a generated path, in the same save', async () => {
    const keeper = keeperWith([{ documentId: NOTE, path: 'untitled' }])

    const result = await applyWorkspaceDocumentUpdate(keeper.deps, {
      workspaceId: WS,
      update: typed(keeper.client, NOTE, '# Weekly review\n\nbody'),
    })

    expect(result).toBe('applied')
    expect(keeper.nameOf(NOTE)).toBe('Weekly review')
    // One write carrying the name, so the fan-out hands it to every replica.
    expect(keeper.saved).toEqual([JSON.stringify(['Weekly review'])])
  })

  it('leaves a placed note unnamed: its path says somebody already chose', async () => {
    const keeper = keeperWith([{ documentId: NOTE, path: 'notes/weekly' }])

    await applyWorkspaceDocumentUpdate(keeper.deps, {
      workspaceId: WS,
      update: typed(keeper.client, NOTE, '# Weekly review\n'),
    })

    expect(keeper.nameOf(NOTE)).toBeUndefined()
  })

  it('never replaces a name a person gave', async () => {
    const keeper = keeperWith([{ documentId: NOTE, path: 'untitled', name: 'Meeting' }])

    await applyWorkspaceDocumentUpdate(keeper.deps, {
      workspaceId: WS,
      update: typed(keeper.client, NOTE, '# From the list\n'),
    })

    expect(keeper.nameOf(NOTE)).toBe('Meeting')
  })

  it('grows a name it seeded while the heading is still being typed', async () => {
    const keeper = keeperWith([{ documentId: NOTE, path: 'untitled-2' }])
    await applyWorkspaceDocumentUpdate(keeper.deps, {
      workspaceId: WS,
      update: typed(keeper.client, NOTE, '# From'),
    })
    expect(keeper.nameOf(NOTE)).toBe('From')

    const from = keeper.client.oplogVersion()
    const body = documentContainers(keeper.client, NOTE).getText(MARKDOWN_BODY_KEY)
    body.insert(body.length, ' the list')
    keeper.client.commit()
    await applyWorkspaceDocumentUpdate(keeper.deps, {
      workspaceId: WS,
      update: keeper.client.export({ mode: 'update', from }) as Uint8Array,
    })

    expect(keeper.nameOf(NOTE)).toBe('From the list')
  })

  // The judgement is per document the update wrote to, so a keystroke does
  // not pay for reading every body in the workspace.
  it('looks only at the documents the update wrote to', async () => {
    const keeper = keeperWith([
      { documentId: NOTE, path: 'untitled' },
      { documentId: OTHER, path: 'untitled-2', body: '# Older heading\n' },
    ])

    await applyWorkspaceDocumentUpdate(keeper.deps, {
      workspaceId: WS,
      update: typed(keeper.client, NOTE, '# Weekly review\n'),
    })

    expect(keeper.nameOf(NOTE)).toBe('Weekly review')
    expect(keeper.nameOf(OTHER)).toBeUndefined()
  })
})
