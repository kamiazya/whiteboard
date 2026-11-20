/**
 * What judging a promote's carried versions costs, COUNTED: the characters
 * the judgement projects, and how much of the record's history the one fork
 * is moved across between them.
 *
 * A row is judged once per (point, document), so rows that each name a
 * distinct point all miss that memo, and every miss checks the fork out,
 * projects the document and judges its size on the serving loop.
 */
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  MARKDOWN_BODY_KEY,
  type RecordSession,
} from '@kamiazya/whiteboard-loro-adapter'
import { encodeFrontiers, type Frontiers, LoroDoc } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { leasedSession } from '../test-utils/leased-session.js'
import { judgeCarried } from './promote-carried.js'

/** What judging cost one session, counted per session so no test reads another's. */
interface Tally {
  judgements: number
  sizeCharged: number
  projectingReads: number
}

/** The reads that project a document into one of its own: what a judgement costs, per read. */
const PROJECTING = new Set(['documentJudgement'])

/** `session` with each named read of a past view counted, and the size each judgement was charged. */
function counted(session: RecordSession): { session: RecordSession; tally: Tally } {
  const tally: Tally = { judgements: 0, sizeCharged: 0, projectingReads: 0 }
  const tallied = async <T>(
    query: Parameters<RecordSession['read']>[0],
    run: () => Promise<T>,
  ): Promise<T> => {
    const answer = await run()
    if (PROJECTING.has(query.query)) tally.projectingReads += 1
    if (query.query === 'documentJudgement') {
      tally.judgements += 1
      tally.sizeCharged += (answer as { stateSize: number }).stateSize
    }
    return answer
  }
  const counting: RecordSession = {
    ...session,
    view(frontiers) {
      const view = session.view(frontiers)
      return { ...view, read: (query, shape) => tallied(query, () => view.read(query, shape)) }
    },
  }
  return { session: counting, tally }
}

async function countedSession(snapshot: Uint8Array) {
  return counted(await leasedSession(snapshot))
}

const DOCUMENT_ID = '01BRWAAAAAAAAAAAAAAAAAAAA0'
const BODY_CHARS = 16 * 1024
const POINTS = 400

/** One markdown document of `bodyChars`, then `count` one-character edits, each its own point. */
function recordWithManyPoints(
  bodyChars = BODY_CHARS,
  count = POINTS,
): { incoming: LoroDoc; snapshot: Uint8Array; points: Uint8Array[] } {
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
  const snapshot = doc.export({ mode: 'snapshot' })
  const incoming = new LoroDoc()
  incoming.import(snapshot)
  return { incoming, snapshot, points }
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
    const { incoming, snapshot, points } = recordWithManyPoints()
    const rows = alternatingRows(points)
    const { crossed } = countCrossings(incoming)
    const { session, tally } = await countedSession(snapshot)
    const judged = await judgeCarried(session, { trash: [], versions: rows })
    if (judged.kind !== 'admitted') throw new Error(`not admitted: ${judged.kind}`)
    expect(tally.judgements).toBe(POINTS)
    expect(tally.sizeCharged).toBeGreaterThan(POINTS * BODY_CHARS)
    // One projection answers a judgement's size, limits, digest and node count.
    expect(tally.projectingReads).toBe(POINTS)
    // One pass over the history: the body's insert, then each edit once.
    expect(crossed()).toBeLessThanOrEqual(opsUpTo(incoming, incoming.oplogFrontiers()))
    // The answer keeps the caller's rows, in the caller's order.
    expect(judged.versions.map((row) => row.id)).toEqual(rows.map((row) => row.id))
    const head = judged.versions.at(-1)
    expect(head?.frontiers).toEqual(rows.at(-1)?.frontiers)
  }, 60_000)

  it('orders by history, not by the spelling of a point', async () => {
    // Counters from two digits to three, so a point's text sorts unlike its place in history.
    const { incoming, snapshot, points } = recordWithManyPoints(1, 120)
    const rows = alternatingRows(points)
    const { crossed } = countCrossings(incoming)
    const judged = await judgeCarried((await countedSession(snapshot)).session, {
      trash: [],
      versions: rows,
    })
    expect(judged.kind).toBe('admitted')
    expect(crossed()).toBeLessThanOrEqual(opsUpTo(incoming, incoming.oplogFrontiers()))
  })

  it('refuses the rows once judging them has projected more than the budget', async () => {
    const { snapshot, points } = recordWithManyPoints()
    const rows = alternatingRows(points)
    const budget = 10 * BODY_CHARS
    const { session, tally } = await countedSession(snapshot)
    const judged = await judgeCarried(session, { trash: [], versions: rows }, budget)
    expect(judged).toEqual({ kind: 'over-budget', limit: budget })
    // Refused at the first judgement past the budget, not after all of them.
    expect(tally.judgements).toBeLessThanOrEqual(11)
  })

  it('admits rows whose judgements together project exactly the budget', async () => {
    const { snapshot, points } = recordWithManyPoints()
    const rows = alternatingRows(points).slice(0, 4)
    const first = await countedSession(snapshot)
    const exact = await judgeCarried(first.session, { trash: [], versions: rows })
    if (exact.kind !== 'admitted') throw new Error(`not admitted: ${exact.kind}`)
    const projected = first.tally.sizeCharged
    const judged = await judgeCarried(
      (await countedSession(snapshot)).session,
      { trash: [], versions: rows },
      projected,
    )
    expect(judged.kind).toBe('admitted')
    const refused = await judgeCarried(
      (await countedSession(snapshot)).session,
      { trash: [], versions: rows },
      projected - 1,
    )
    expect(refused.kind).toBe('over-budget')
  })
})
