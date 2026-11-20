/**
 * A document's content is the workspace tree's node and nothing else: there is
 * no per-document record to fall back on, so an id the tree does not hold is
 * `null` and a tree that cannot be read is an unreadable answer, never `null`.
 */
import 'fake-indexeddb/auto'
import {
  type RecordLease,
  writeCoreFacets,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { Loro } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedPreTreeContentRow } from '../test-utils/seed-retired-sync-row.js'
import { seedTreeDocument } from '../test-utils/seed-workspace-content.js'
import { BrowserWorkspaceRecords } from './browser-workspace-records.js'
import { lazyContentRecord, loadDocument, withHeldDocument } from './workspace-content.js'

claimIsolatedWhiteboardDb('workspace-content')

/** The leases `BrowserWorkspaceRecords` hands out from now on, so a test can ask whether each was given back. */
function trackLeases(): RecordLease[] {
  const leases: RecordLease[] = []
  const open = BrowserWorkspaceRecords.prototype.open
  vi.spyOn(BrowserWorkspaceRecords.prototype, 'open').mockImplementation(async function (
    this: BrowserWorkspaceRecords,
    workspaceId: string,
  ) {
    const opened = await open.call(this, workspaceId)
    if (opened !== null) leases.push(opened)
    return opened
  })
  return leases
}

/** Whether the engine still holds the lease's handle. */
function isHeld(held: RecordLease): boolean {
  try {
    held.engine.version({ handle: held.handle })
    return true
  } catch {
    return false
  }
}

describe('loadDocument', () => {
  beforeEach(clearWhiteboardDb)
  afterEach(() => vi.restoreAllMocks())

  it('reads a document the tree holds', async () => {
    const source = new Loro()
    writeMarkdownBody(source, 'held by the tree')
    const entry = await seedTreeDocument({
      path: 'notes/held',
      kind: 'markdown',
      content: source.export({ mode: 'snapshot' }),
    })

    expect(await loadDocument(entry.documentId, (held) => held.body())).toBe('held by the tree')
  })

  it("reads a markdown document's content and tags in ONE engine read", async () => {
    const source = new Loro()
    writeMarkdownBody(source, 'tagged body')
    writeCoreFacets(source, { type: 'note', tags: ['team:a', 'q3'] })
    const entry = await seedTreeDocument({
      path: 'notes/tagged',
      kind: 'markdown',
      content: source.export({ mode: 'snapshot' }),
    })
    const leases = trackLeases()
    const reads: string[] = []

    const read = await loadDocument(entry.documentId, async (held) => {
      const lease = leases[0] as RecordLease
      const engineRead = lease.engine.read.bind(lease.engine)
      vi.spyOn(lease.engine, 'read').mockImplementation(async (request) => {
        reads.push(request.query.query)
        return engineRead(request)
      })
      return held.contentWithTags('markdown')
    })

    expect(read).toEqual({
      content: { kind: 'markdown', body: 'tagged body' },
      tags: ['team:a', 'q3'],
    })
    expect(reads).toHaveLength(1)
  })

  it('answers null for an id the tree does not hold, even beside a per-document record', async () => {
    await seedTreeDocument({ path: 'notes/other', kind: 'markdown' })
    const stray = generateDocumentId()
    await seedPreTreeContentRow(stray)

    expect(await loadDocument(stray, (held) => held.body())).toBeNull()
    expect(await loadDocument(stray, async (held) => held.projection())).toBeNull()
  })

  it('throws, rather than answering null, when the tree could not be read', async () => {
    const entry = await seedTreeDocument({ path: 'notes/held', kind: 'markdown' })
    vi.spyOn(BrowserWorkspaceRecords.prototype, 'open').mockRejectedValue(new Error('closed'))

    await expect(loadDocument(entry.documentId, (held) => held.body())).rejects.toThrow(
      /could not be read/,
    )
  })

  it('hands the projection as bytes that open to the document alone', async () => {
    const source = new Loro()
    writeMarkdownBody(source, 'projected body')
    const entry = await seedTreeDocument({
      path: 'notes/projected',
      kind: 'markdown',
      content: source.export({ mode: 'snapshot' }),
    })

    const bytes = await loadDocument(entry.documentId, async (held) => held.projection())

    const opened = new Loro()
    opened.import(bytes as Uint8Array)
    expect(opened.getText('body').toString()).toBe('projected body')
  })

  it('rethrows a read that failed on a document the tree holds, and gives the record back', async () => {
    const entry = await seedTreeDocument({ path: 'notes/held', kind: 'markdown' })
    const leases = trackLeases()
    const refusal = new Error('the caller refused')

    await expect(
      loadDocument(entry.documentId, async () => {
        throw refusal
      }),
    ).rejects.toBe(refusal)

    expect(leases).toHaveLength(1)
    expect(leases.some(isHeld)).toBe(false)
  })
})

describe('withHeldDocument over a lazily opened record', () => {
  beforeEach(clearWhiteboardDb)
  afterEach(() => vi.restoreAllMocks())

  it('opens the record on the first read only, and releasing it before any read opens nothing', async () => {
    const entry = await seedTreeDocument({ path: 'notes/a', kind: 'markdown' })
    const leases = trackLeases()
    await lazyContentRecord().release()
    expect(leases).toHaveLength(0)

    const lazy = lazyContentRecord()
    await withHeldDocument(await lazy.open(), entry.documentId, (held) => held.body())
    await withHeldDocument(await lazy.open(), entry.documentId, (held) => held.body())

    expect(leases).toHaveLength(1)
    expect(leases.some(isHeld)).toBe(true)
    await lazy.release()
    expect(leases.some(isHeld)).toBe(false)
  })
})
