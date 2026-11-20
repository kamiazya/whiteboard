// @vitest-environment node
/**
 * What the keeper's budget charges for judging versions, priced over this
 * browser's copy of the record: the state size of the document at each
 * version's point, each distinct (point, document) once, and nothing for a
 * point this record cannot reach.
 */
import {
  createWorkspaceDocumentAtPath,
  loadCrdtEngine,
  projectWorkspaceDocument,
  stateSize,
  writeSpatialCanvas,
  writeWorkspaceDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import { bytesToBase64Url, newImageRef } from '@kamiazya/whiteboard-model'
import { fileNode } from '@kamiazya/whiteboard-model/test-utils'
import { encodeFrontiers, LoroDoc } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withLeaseOf } from '../test-utils/replica-lease.js'
import { versionsWithinJudgedBudget } from './carried-planes.js'

const KNOWN = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const LATER = '01ARZ3NDEKTSV4RRFFQ69G5FAW'

function drawing(count: number): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: Array.from({ length: count }, (_, i) =>
      fileNode({
        id: `n${i}`,
        file: newImageRef(`img-${i}`),
        x: i * 20,
        y: 0,
        width: 9,
        height: 9,
      }),
    ),
    edges: [],
  })
  return doc
}

const pointOf = (record: LoroDoc) =>
  bytesToBase64Url(new Uint8Array(encodeFrontiers(record.oplogFrontiers())))

const version = (id: string, documentId: string, frontiers: string, createdAt: number) => ({
  id,
  documentId,
  createdAt,
  auto: false,
  frontiers,
})

/** A record in which KNOWN drew one node and then three, and LATER was created after both points. */
function history() {
  const record = new LoroDoc()
  createWorkspaceDocumentAtPath(record, { path: 'known', documentId: KNOWN, kind: 'spatial' })
  writeWorkspaceDocumentContent(record, KNOWN, drawing(1))
  const small = pointOf(record)
  const smallSize = stateSize(projectWorkspaceDocument(record, KNOWN) as LoroDoc)
  writeWorkspaceDocumentContent(record, KNOWN, drawing(3))
  const large = pointOf(record)
  const largeSize = stateSize(projectWorkspaceDocument(record, KNOWN) as LoroDoc)
  createWorkspaceDocumentAtPath(record, { path: 'later', documentId: LATER, kind: 'spatial' })
  return { record, small, large, smallSize, largeSize }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('versionsWithinJudgedBudget prices a version as the keeper charges it', () => {
  it('keeps the newest versions whose state sizes sum within the limit, and no more', async () => {
    const { record, small, large, smallSize, largeSize } = history()
    expect(smallSize).toBeLessThan(largeSize)
    const versions = [version('old', KNOWN, small, 1), version('new', KNOWN, large, 2)]

    const exact = await withLeaseOf(record, (held) =>
      versionsWithinJudgedBudget(held, versions, largeSize + smallSize),
    )
    const short = await withLeaseOf(record, (held) =>
      versionsWithinJudgedBudget(held, versions, largeSize + smallSize - 1),
    )

    expect(exact).toEqual({ kept: versions, dropped: 0 })
    expect(short).toEqual({ kept: [versions[1]], dropped: 1 })
  })

  it('charges one point of one document once, however many versions name it', async () => {
    const { record, large, largeSize } = history()
    const versions = [version('a', KNOWN, large, 1), version('b', KNOWN, large, 2)]

    const fitted = await withLeaseOf(record, (held) =>
      versionsWithinJudgedBudget(held, versions, largeSize),
    )

    expect(fitted).toEqual({ kept: versions, dropped: 0 })
  })

  it('charges nothing for a document the point predates, or a point the record never held', async () => {
    const { record, small } = history()
    const foreign = new LoroDoc()
    foreign.getText('t').insert(0, 'x')
    foreign.commit()
    const versions = [
      version('before-it-existed', LATER, small, 1),
      version('foreign-point', KNOWN, pointOf(foreign), 2),
      version('not-a-point', KNOWN, 'AA', 3),
      version('not-base64', KNOWN, '!!', 4),
    ]

    const fitted = await withLeaseOf(record, (held) =>
      versionsWithinJudgedBudget(held, versions, 0),
    )

    expect(fitted).toEqual({ kept: versions, dropped: 0 })
  })

  it('gives the one view it moved back, and opens none when it prices nothing', async () => {
    const { record, small, large, smallSize, largeSize } = history()
    const engine = await loadCrdtEngine()
    const fork = vi.spyOn(engine, 'fork')
    const close = vi.spyOn(engine, 'close')

    await withLeaseOf(record, async (lent) => {
      await versionsWithinJudgedBudget(lent, [], 1)
      expect(fork).not.toHaveBeenCalled()

      await versionsWithinJudgedBudget(
        lent,
        [version('old', KNOWN, small, 1), version('new', KNOWN, large, 2)],
        smallSize + largeSize,
      )

      expect(fork).toHaveBeenCalledOnce()
      const forkedHandle = fork.mock.results.flatMap((result) =>
        result.type === 'return' ? [result.value.handle] : [],
      )[0]
      // The view is given back, and so is the standalone document each version's
      // projection opens; the lent record is not the view's to close.
      expect(close).toHaveBeenCalledWith({ handle: forkedHandle })
      expect(close).not.toHaveBeenCalledWith({ handle: lent.handle })
      expect(close).toHaveBeenCalledTimes(3)
      expect(() => lent.engine.version({ handle: lent.handle })).not.toThrow()
    })
  })
})
