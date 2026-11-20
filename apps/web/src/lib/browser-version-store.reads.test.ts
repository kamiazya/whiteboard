// @vitest-environment node
/**
 * The saved versions as the file scan reads them: one view of the record moved
 * from point to point, and given back whether the scan finishes or throws.
 */
import {
  createWorkspaceDocumentAtPath,
  loadCrdtEngine,
  writeSpatialCanvas,
  writeWorkspaceDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import { newImageRef } from '@kamiazya/whiteboard-model'
import { fileNode } from '@kamiazya/whiteboard-model/test-utils'
import { encodeFrontiers, LoroDoc } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withLeaseOf } from '../test-utils/replica-lease.js'
import { recordFrontier, withSavedVersionReads } from './browser-version-store.js'

const DOCUMENT = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const holder = { documentId: DOCUMENT, path: 'page', trashed: false } as const

function drawing(fileId: string): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: [fileNode({ id: 'n', file: newImageRef(fileId), x: 0, y: 0, width: 9, height: 9 })],
    edges: [],
  })
  return doc
}

/** A record that drew `img-one`, then `img-two`, then `img-three`, with the frontiers of the first two. */
function history() {
  const record = new LoroDoc()
  createWorkspaceDocumentAtPath(record, { path: 'page', documentId: DOCUMENT, kind: 'spatial' })
  const rows: Array<{ id: string; documentId: string; frontiers: Uint8Array<ArrayBuffer> }> = []
  for (const [id, fileId] of [
    ['v1', 'img-one'],
    ['v2', 'img-two'],
  ] as const) {
    writeWorkspaceDocumentContent(record, DOCUMENT, drawing(fileId))
    rows.push({
      id,
      documentId: DOCUMENT,
      frontiers: new Uint8Array(encodeFrontiers(record.oplogFrontiers())),
    })
  }
  writeWorkspaceDocumentContent(record, DOCUMENT, drawing('img-three'))
  return { record, rows }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('withSavedVersionReads', () => {
  it('lists a document its own versions and reads what each drew, moving one view', async () => {
    const { record, rows } = history()
    const engine = await loadCrdtEngine()
    const fork = vi.spyOn(engine, 'fork')

    const seen = await withLeaseOf(record, (lent) =>
      withSavedVersionReads(lent, rows, async (versions) => ({
        listed: await versions.list(holder),
        other: await versions.list({ ...holder, documentId: 'someone-else' }),
        first: await versions.imageRefIds(holder, 'v1'),
        second: await versions.imageRefIds(holder, 'v2'),
        back: await versions.imageRefIds(holder, 'v1'),
      })),
    )

    expect(seen).toEqual({
      listed: ['v1', 'v2'],
      other: [],
      first: ['img-one'],
      second: ['img-two'],
      back: ['img-one'],
    })
    expect(fork).toHaveBeenCalledOnce()
  })

  it('answers null for a version it was never given', async () => {
    const { record, rows } = history()

    const answer = await withLeaseOf(record, (lent) =>
      withSavedVersionReads(lent, rows, (versions) => versions.imageRefIds(holder, 'v-unknown')),
    )

    expect(answer).toBeNull()
  })

  it('gives the view back when the scan throws, and makes none when nothing is read', async () => {
    const { record, rows } = history()
    const engine = await loadCrdtEngine()
    const fork = vi.spyOn(engine, 'fork')
    const close = vi.spyOn(engine, 'close')

    await withLeaseOf(record, async (lent) => {
      await withSavedVersionReads(lent, rows, async () => 'no version read')
      expect(close).not.toHaveBeenCalled()

      await expect(
        withSavedVersionReads(lent, rows, async (versions) => {
          await versions.imageRefIds(holder, 'v1')
          throw new Error('the scan failed')
        }),
      ).rejects.toThrow('the scan failed')

      const [view] = fork.mock.results.flatMap((result) =>
        result.type === 'return' ? [result.value.handle] : [],
      )
      expect(close).toHaveBeenCalledOnce()
      expect(close).toHaveBeenCalledWith({ handle: view })
      expect(view).not.toBe(lent.handle)
    })
  })
})

describe('recordFrontier', () => {
  it('names the operations the live record holds: equal while nothing is added, changed by an edit', () => {
    const { record } = history()
    const before = recordFrontier(record)

    expect(recordFrontier(record)).toEqual(before)
    expect(recordFrontier(LoroDoc.fromSnapshot(record.export({ mode: 'snapshot' })))).toEqual(
      before,
    )

    writeWorkspaceDocumentContent(record, DOCUMENT, drawing('img-four'))
    expect(recordFrontier(record)).not.toEqual(before)
  })
})
