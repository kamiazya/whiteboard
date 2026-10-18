/**
 * What the reference machinery costs on the bodies a caller can write: the
 * scanner every render, backlinks request and stringify runs, the unlinked-
 * mention pass behind backlinks and linkify, and the heap a document's cached
 * reference facts hold against the body they came from.
 *
 * Run (from packages/mcp-server):
 *   node --expose-gc --import tsx/esm scripts/measure/reference-scan-cost.mjs [scale...]
 *
 * Each scale is a repeat count for the adversarial shape; the default doubles
 * four times, so a row that quadruples per doubling is quadratic and one that
 * doubles is linear. Times are the median of five calls, in milliseconds.
 *
 * Shapes:
 * - `scan [[#`: `'[[#'.repeat(N) + ']'` — every opener's target is empty, so
 *   a scan that resumes two characters on re-walks to the one final `]`.
 * - `scan [[`: `'[['.repeat(N)` — the shape the scanner was first made linear
 *   for, as the control.
 * - `mentions`: `'[[q]] N '.repeat(N)` against a document named `N` — as many
 *   references as occurrences, so a per-occurrence walk of the references is
 *   occurrences x references.
 * - `facts heap`: `'[[a]] '.repeat(N)` as a markdown body, held in a
 *   `ContentFactsCache`; retained JS heap after a full GC over the body's own
 *   UTF-16 bytes is the amplification.
 *
 * WHAT IT MEASURED, 2026-10-18, on this machine (Node 22), before and after
 * the fixes it was written to judge:
 *
 *     scale   scan [[#          mentions
 *      2000     38.5 ->  0.7     49.6 -> 0.2
 *     16000   2389.8 ->  0.6   1048.3 -> 0.0
 *
 *     body chars   refs    retained, before -> after
 *         262140  43690    11615KB (22.7x) -> 3354KB (6.6x)
 *
 * What is left of the heap row is one small object per reference plus the
 * body itself; a per-document reference cap would bound it further, at the
 * cost of rename-follow and backlinks seeing nothing past the cap.
 */
import { scanReferences } from '@kamiazya/whiteboard-codec'
import { writeMarkdownBody } from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { backlinksIn, ContentFactsCache } from '../../../reference-graph/src/index.ts'

const args = process.argv.slice(2).map(Number)
const scales = args.length > 0 ? args : [2000, 4000, 8000, 16000]

function median(fn) {
  const times = []
  for (let i = 0; i < 5; i++) {
    const start = performance.now()
    fn()
    times.push(performance.now() - start)
  }
  times.sort((a, b) => a - b)
  return times[2]
}

const SOURCE = '01ARZ3NDEKTSV4RRFFQ69G5FA1'
const TARGET = '01ARZ3NDEKTSV4RRFFQ69G5FA2'

function mentionsMs(n) {
  const text = '[[q]] N '.repeat(n)
  const entries = [
    { documentId: SOURCE, path: 'source', kind: 'markdown' },
    { documentId: TARGET, path: 'target', name: 'N', kind: 'markdown' },
  ]
  const content = new Map([[SOURCE, { refs: [], texts: [text] }]])
  return median(() => backlinksIn(entries, content, TARGET))
}

async function factsHeap(n) {
  const body = '[[a]] '.repeat(n)
  const doc = new LoroDoc()
  writeMarkdownBody(doc, body)
  doc.commit()
  const cache = new ContentFactsCache({ loadDocument: async () => doc })
  const entry = { documentId: SOURCE, path: 'source', kind: 'markdown', contentDigest: 'd' }
  globalThis.gc()
  const before = process.memoryUsage().heapUsed
  const facts = await cache.factsFor('ws', [entry])
  globalThis.gc()
  const after = process.memoryUsage().heapUsed
  const refs = facts.get(SOURCE).refs.length
  return { bodyBytes: body.length * 2, retained: after - before, refs }
}

if (typeof globalThis.gc !== 'function') {
  console.error('run with --expose-gc: the heap rows need a full GC between reads')
  process.exit(1)
}

console.log('scale   scan [[#   scan [[    mentions')
for (const n of scales) {
  const hash = `${'[[#'.repeat(n)}]`
  const open = '[['.repeat(n)
  const row = [
    String(n).padStart(5),
    median(() => scanReferences(hash))
      .toFixed(1)
      .padStart(10),
    median(() => scanReferences(open))
      .toFixed(1)
      .padStart(9),
    mentionsMs(n).toFixed(1).padStart(11),
  ]
  console.log(row.join(''))
}

console.log('\nbody chars   refs     body KB   retained KB   amplification')
for (const n of [1000, 10000, 43690]) {
  const { bodyBytes, retained, refs } = await factsHeap(n)
  console.log(
    [
      String(n * 6).padStart(10),
      String(refs).padStart(7),
      (bodyBytes / 1024).toFixed(0).padStart(11),
      (retained / 1024).toFixed(0).padStart(13),
      `${(retained / bodyBytes).toFixed(1)}x`.padStart(15),
    ].join(''),
  )
}
