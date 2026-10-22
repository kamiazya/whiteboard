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
import { decodeFrontiers, encodeFrontiers, type Frontiers, LoroDoc } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { judgeCarried } from './promote-carried.js'

const tally = { projections: 0, charsProjected: 0, elementsJudged: 0 }

vi.mock('@kamiazya/whiteboard-loro-adapter', async (importOriginal) => {
  const real = await importOriginal<typeof loroAdapter>()
  return {
    ...real,
    projectWorkspaceDocument: (...args: Parameters<typeof real.projectWorkspaceDocument>) => {
      const content = real.projectWorkspaceDocument(...args)
      if (content !== null) {
        tally.projections += 1
        tally.charsProjected += content.getText(real.MARKDOWN_BODY_KEY).length
        // A fresh copy's oplog is its state: one op per character, entry or element.
        for (const count of content.oplogVersion().toJSON().values()) tally.elementsJudged += count
      }
      return content
    },
  }
})

const DOCUMENT_ID = '01BRWAAAAAAAAAAAAAAAAAAAA0'
const BODY_CHARS = 16 * 1024
const POINTS = 400

/** One markdown document of `bodyChars`, then `count` one-character edits, each its own point. */
function recordWithManyPoints(
  bodyChars = BODY_CHARS,
  count = POINTS,
): { incoming: LoroDoc; points: Uint8Array[] } {
  const doc = new LoroDoc()
  doc.setPeerId(2n)
  createWorkspaceDocumentAtPath(doc, { path: 'notes', documentId: DOCUMENT_ID, kind: 'markdown' })
  const body = documentContainers(doc, DOCUMENT_ID).getText(MARKDOWN_BODY_KEY)
  body.insert(0, 'a'.repeat(bodyChars))
  doc.commit()
  const points: Uint8Array[] = []
  for (let i = 0; i < count; i += 1) {
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
  tally.elementsJudged = 0
  vi.restoreAllMocks()
})

/** Counts the ops each checkout of the fork moves across, from the record's start. */
function countCrossings(incoming: LoroDoc): { crossed: () => number } {
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
  return { crossed: () => crossed }
}

describe('judgeCarried, rows at distinct points', () => {
  it('moves the fork forward only, however the rows alternate between early and late', async () => {
    const { incoming, points } = recordWithManyPoints()
    const rows = alternatingRows(points)
    const { crossed } = countCrossings(incoming)
    const judged = await judgeCarried(incoming, { trash: [], versions: rows })
    if (judged.kind !== 'admitted') throw new Error(`not admitted: ${judged.kind}`)
    expect(tally.projections).toBe(POINTS)
    expect(tally.charsProjected).toBeGreaterThan(POINTS * BODY_CHARS)
    // One pass over the history: the body's insert, then each edit once.
    expect(crossed()).toBeLessThanOrEqual(opsUpTo(incoming, incoming.oplogFrontiers()))
    // The answer keeps the caller's rows, in the caller's order.
    expect(judged.versions.map((row) => row.id)).toEqual(rows.map((row) => row.id))
    const head = judged.versions.at(-1)
    expect(head?.frontiers).toEqual(decodeFrontiers(rows.at(-1)?.frontiers ?? new Uint8Array()))
  }, 60_000)

  it('orders by history, not by the spelling of a point', async () => {
    // Counters from two digits to three, so a point's text sorts unlike its place in history.
    const { incoming, points } = recordWithManyPoints(1, 120)
    const rows = alternatingRows(points)
    const { crossed } = countCrossings(incoming)
    const judged = await judgeCarried(incoming, { trash: [], versions: rows })
    expect(judged.kind).toBe('admitted')
    expect(crossed()).toBeLessThanOrEqual(opsUpTo(incoming, incoming.oplogFrontiers()))
  })

  it('refuses the rows once judging them has projected more than the budget', async () => {
    const { incoming, points } = recordWithManyPoints()
    const rows = alternatingRows(points)
    const budget = 10 * BODY_CHARS
    const judged = await judgeCarried(incoming, { trash: [], versions: rows }, budget)
    expect(judged).toEqual({ kind: 'over-budget', limit: budget })
    // Refused at the first judgement past the budget, not after all of them.
    expect(tally.projections).toBeLessThanOrEqual(11)
  })

  it('admits rows whose judgements together project exactly the budget', async () => {
    const { incoming, points } = recordWithManyPoints()
    const rows = alternatingRows(points).slice(0, 4)
    const exact = await judgeCarried(incoming, { trash: [], versions: rows })
    if (exact.kind !== 'admitted') throw new Error(`not admitted: ${exact.kind}`)
    const projected = tally.elementsJudged
    tally.elementsJudged = 0
    const judged = await judgeCarried(incoming, { trash: [], versions: rows }, projected)
    expect(judged.kind).toBe('admitted')
    const refused = await judgeCarried(incoming, { trash: [], versions: rows }, projected - 1)
    expect(refused.kind).toBe('over-budget')
  })
})
