/**
 * What judging a promote's carried versions costs, COUNTED: the characters
 * the judgement projects, and how much of the record's history the one fork
 * is moved across between them.
 *
 * A row is judged once per (point, document), so rows that each name a
 * distinct point all miss that memo, and every miss checks the fork out,
 * projects the document and judges its size on the serving loop.
 */
import type * as loroAdapter from '@kamiazya/whiteboard-loro-adapter'
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  MARKDOWN_BODY_KEY,
} from '@kamiazya/whiteboard-loro-adapter'
import { encodeFrontiers, type Frontiers, LoroDoc } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { judgeCarried } from './promote-carried.js'

const tally = { projections: 0, charsProjected: 0 }

vi.mock('@kamiazya/whiteboard-loro-adapter', async (importOriginal) => {
  const real = await importOriginal<typeof loroAdapter>()
  return {
    ...real,
    projectWorkspaceDocument: (...args: Parameters<typeof real.projectWorkspaceDocument>) => {
      const content = real.projectWorkspaceDocument(...args)
      if (content !== null) {
        tally.projections += 1
        tally.charsProjected += content.getText(real.MARKDOWN_BODY_KEY).length
      }
      return content
    },
  }
})

const DOCUMENT_ID = '01BRWAAAAAAAAAAAAAAAAAAAA0'
const BODY_CHARS = 16 * 1024
const POINTS = 400

/** One markdown document of `BODY_CHARS`, then `POINTS` one-character edits, each its own point. */
function recordWithManyPoints(): { incoming: LoroDoc; points: Uint8Array[] } {
  const doc = new LoroDoc()
  doc.setPeerId(2n)
  createWorkspaceDocumentAtPath(doc, { path: 'notes', documentId: DOCUMENT_ID, kind: 'markdown' })
  const body = documentContainers(doc, DOCUMENT_ID).getText(MARKDOWN_BODY_KEY)
  body.insert(0, 'a'.repeat(BODY_CHARS))
  doc.commit()
  const points: Uint8Array[] = []
  for (let i = 0; i < POINTS; i += 1) {
    body.insert(body.length, 'b')
    doc.commit()
    points.push(encodeFrontiers(doc.oplogFrontiers()))
  }
  const incoming = new LoroDoc()
  incoming.import(doc.export({ mode: 'snapshot' }))
  return { incoming, points }
}

/** Rows alternating between the early half of the points and the late half. */
function alternatingRows(points: readonly Uint8Array[]) {
  const half = points.length / 2
  return points.map((_, i) => {
    const at = i % 2 === 0 ? i / 2 : half + (i - 1) / 2
    return {
      id: `row-${i}`,
      documentId: DOCUMENT_ID,
      createdAt: i,
      auto: true,
      frontiers: points[at] as Uint8Array,
    }
  })
}

/** Ops the record holds up to `frontiers`, which a checkout from one point to another moves across the difference of. */
function opsUpTo(doc: LoroDoc, frontiers: Frontiers): number {
  let total = 0
  for (const count of doc.frontiersToVV(frontiers).toJSON().values()) total += count
  return total
}

afterEach(() => {
  tally.projections = 0
  tally.charsProjected = 0
  vi.restoreAllMocks()
})

describe('judgeCarried, rows at distinct points', () => {
  it('counts the projections and the history crossed by rows alternating early and late', async () => {
    const { incoming, points } = recordWithManyPoints()
    const rows = alternatingRows(points)
    let crossed = 0
    let previous = 0
    const realCheckout = LoroDoc.prototype.checkout
    vi.spyOn(LoroDoc.prototype, 'checkout').mockImplementation(function (
      this: LoroDoc,
      frontiers: Frontiers,
    ) {
      const at = opsUpTo(incoming, frontiers)
      crossed += Math.abs(at - previous)
      previous = at
      return realCheckout.call(this, frontiers)
    })
    const judged = await judgeCarried(incoming, { trash: [], versions: rows })
    expect(judged.kind).toBe('admitted')
    expect(tally.projections).toBe(POINTS)
    expect(tally.charsProjected).toBeGreaterThan(POINTS * BODY_CHARS)
    // Each step crosses about half the edits.
    expect(crossed).toBeGreaterThan((POINTS * POINTS) / 4)
  }, 60_000)
})
