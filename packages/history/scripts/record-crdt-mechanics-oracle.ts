/**
 * Records `src/oracle/crdt-mechanics.jsonl`: what this package's pure judgements
 * answer under the installed loro-crdt — the compaction cut over a recorded
 * document and its versions, the frontiers text codec with its refusals, and
 * the retention passes over plain rows.
 *
 *   pnpm --filter @kamiazya/whiteboard-mcp exec tsx \
 *     ../history/scripts/record-crdt-mechanics-oracle.ts
 *
 * Peer ids are fixed and every random choice comes from a seeded generator, so
 * a re-run under the same loro-crdt writes the same file. The recording is the
 * oracle for the Rust `whiteboard-crdt` crate: re-take it only deliberately.
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Frontiers, LoroDoc } from 'loro-crdt'
import {
  autoVersionsOverCap,
  CHECKPOINT_QUIET_MS,
  carriedAutoVersionsOverCap,
  MAX_AUTO_PER_DOCUMENT,
  MAX_MANUAL_PER_DOCUMENT,
  MAX_RESTORE_POINTS_PER_DOCUMENT,
  restorePointOptions,
  sandwichedAutoVersionIds,
} from '../src/index.js'
import {
  answer,
  compactionCutOverDoc,
  type FrontierPairs,
  frontiersFromBase64ToFrontiers,
  frontiersOfPairs,
  frontiersToBase64OfFrontiers,
  pairsOfFrontiers,
} from '../src/test-utils/crdt-mechanics-oracle.js'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '..', 'src', 'oracle', 'crdt-mechanics.jsonl')

function rngOf(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
type Rng = () => number
const int = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1))
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

const rows: unknown[] = []
const push = (row: Record<string, unknown>) => rows.push({ id: `${row.op}-${rows.length}`, ...row })

// ---- compactionCut ----

interface Scene {
  doc: LoroDoc
  points: Frontiers[]
}

/** Peers edit one record, merging now and then; every merge point is a version. */
function history(seed: number, peers: number, steps: number): Scene {
  const rng = rngOf(seed)
  const docs = Array.from({ length: peers }, (_, i) => {
    const d = new LoroDoc()
    d.setPeerId(BigInt(10 + i))
    return d
  })
  const points: Frontiers[] = []
  for (let step = 0; step < steps; step++) {
    const doc = docs[int(rng, 0, peers - 1)] as LoroDoc
    doc.getMap('m').set(`k${int(rng, 0, 5)}`, step)
    doc.getText('t').insert(0, `${step}`)
    doc.commit()
    if (rng() < 0.4) {
      const other = docs[int(rng, 0, peers - 1)] as LoroDoc
      if (other !== doc) {
        other.import(doc.export({ mode: 'update', from: other.oplogVersion() }))
        doc.import(other.export({ mode: 'update', from: doc.oplogVersion() }))
      }
    }
    if (rng() < 0.5) points.push(doc.frontiers())
  }
  const main = docs[0] as LoroDoc
  for (const other of docs) main.import(other.export({ mode: 'update' }))
  return { doc: main, points }
}

const fromBytes = (bytes: Uint8Array) => {
  const out = new LoroDoc()
  out.import(bytes)
  return out
}

function cutRow(tag: string, bytes: Uint8Array, points: readonly FrontierPairs[]) {
  const doc = fromBytes(bytes)
  const args = { doc: b64(bytes), points }
  push({
    op: 'compactionCut',
    tag,
    ...args,
    result: answer(() => {
      const cut = compactionCutOverDoc(doc, points.map(frontiersOfPairs))
      return cut === null ? null : pairsOfFrontiers(cut)
    }),
  })
}

for (let i = 0; i < 24; i++) {
  const rng = rngOf(100 + i)
  const { doc, points } = history(200 + i, int(rng, 1, 3), int(rng, 4, 14))
  const bytes = doc.export({ mode: 'snapshot' })
  const pairs = points.map(pairsOfFrontiers)
  const pick = (n: number) => pairs.slice(0, n)
  cutRow('all', bytes, pairs)
  cutRow('first-two', bytes, pick(2))
  cutRow('single', bytes, pick(1))
  cutRow('empty', bytes, [])
  cutRow('head', bytes, [...pairs, pairsOfFrontiers(doc.frontiers())])
  cutRow('unknown-peer', bytes, [...pick(1), [['999999', 3]]])
  cutRow('empty-frontier', bytes, [...pick(1), []])
  if (i % 3 === 0) {
    const root = doc.frontiers()
    const shallow = doc.export({ mode: 'shallow-snapshot', frontiers: root })
    // a point at or before the record's shallow root cannot be cut to
    cutRow('shallow-at-root', shallow, [pairsOfFrontiers(root)])
    cutRow('shallow-before-root', shallow, pick(1))
  }
}
function cutsOverMidHistoryRoot() {
  // a shallow root in the middle of a history, with versions on both sides
  for (let i = 0; i < 6; i++) {
    const { doc, points } = history(300 + i, 2, 12)
    const middle = points[Math.floor(points.length / 2)]
    if (middle === undefined) continue
    const shallow = doc.export({ mode: 'shallow-snapshot', frontiers: middle })
    const pairs = points.map(pairsOfFrontiers)
    cutRow('shallow-mid-all', shallow, pairs)
    cutRow('shallow-mid-after', shallow, pairs.slice(Math.floor(points.length / 2)))
    cutRow('shallow-mid-before', shallow, pairs.slice(0, Math.floor(points.length / 2) + 1))
  }
}

function cutsBesideRoot() {
  // A point concurrent with the shallow root: the cut can fall beside the root, neither before nor after it
  for (let i = 0; i < 6; i++) {
    const rng = rngOf(350 + i)
    const a = new LoroDoc()
    a.setPeerId(10n)
    const b = new LoroDoc()
    b.setPeerId(11n)
    for (let k = 0; k < int(rng, 3, 8); k++) {
      a.getMap('m').set(`a${k}`, k)
      a.commit()
    }
    const root = a.frontiers()
    for (let k = 0; k < int(rng, 2, 5); k++) {
      b.getMap('m').set(`b${k}`, k)
      b.commit()
    }
    const onlyB = b.frontiers()
    a.import(b.export({ mode: 'update' }))
    a.getMap('m').set('after', i)
    a.commit()
    const both = a.frontiers()
    const shallow = a.export({ mode: 'shallow-snapshot', frontiers: root })
    cutRow('shallow-concurrent', shallow, [pairsOfFrontiers(onlyB), pairsOfFrontiers(both)])
    cutRow('shallow-concurrent-beside', shallow, [pairsOfFrontiers(onlyB)])
    cutRow('shallow-concurrent-root', shallow, [pairsOfFrontiers(root), pairsOfFrontiers(both)])
  }
}

cutsOverMidHistoryRoot()
cutsBesideRoot()

// ---- frontiers text codec ----

const frontierSamples: FrontierPairs[] = [
  [],
  [['1', 0]],
  [['1', 41]],
  [['18446744073709551615', 7]],
  [
    ['1', 3],
    ['2', 9],
  ],
  [
    ['3', 1],
    ['1', 1],
    ['2', 1],
  ],
  [['0', 0]],
  [['12345678901234567890', 2147483647]],
]
for (const [i, pairs] of frontierSamples.entries()) {
  push({
    op: 'frontiersToBase64',
    tag: `sample-${i}`,
    frontiers: pairs,
    result: answer(() => frontiersToBase64OfFrontiers(frontiersOfPairs(pairs))),
  })
}
for (let i = 0; i < 12; i++) {
  const { doc } = history(400 + i, 3, 9)
  const pairs = pairsOfFrontiers(doc.frontiers())
  push({
    op: 'frontiersToBase64',
    tag: `history-${i}`,
    frontiers: pairs,
    result: answer(() => frontiersToBase64OfFrontiers(frontiersOfPairs(pairs))),
  })
}
const texts = [
  ...rows
    .filter((r) => (r as { op: string }).op === 'frontiersToBase64')
    .map((r) => ((r as { result: { ok?: string } }).result.ok ?? '') as string),
  '',
  'not base64!!',
  '====',
  'AA==',
  '/w==',
  'AAAAAAAAAAAAAAAA',
  'AQ',
  `${'A'.repeat(64)}`,
  'AQAAAAAAAAAAAAAA',
  'AgAAAAAAAAAAAAAA',
  ' AQAAAAAAAAAAAAAA ',
  'AQAAAAAAAAAAAAAA\n',
]
for (const [i, text] of texts.entries()) {
  push({
    op: 'frontiersFromBase64',
    tag: `text-${i}`,
    text,
    result: answer(() => pairsOfFrontiers(frontiersFromBase64ToFrontiers(text))),
  })
}

// ---- retention ----

interface Candidate {
  id: string
  restoredFrom: string | null
}

function candidates(rng: Rng, n: number): { rows: Candidate[]; referenced: string[] } {
  const made: Candidate[] = Array.from({ length: n }, (_, i) => ({
    id: `v${i}`,
    restoredFrom: null,
  }))
  const referenced: string[] = []
  for (const row of made) {
    if (rng() < 0.18) {
      const target = made[int(rng, 0, made.length - 1)]
      if (target !== undefined && target.id !== row.id) {
        row.restoredFrom = target.id
        referenced.push(target.id)
      }
    }
  }
  return { rows: made, referenced: [...new Set(referenced)] }
}

for (let i = 0; i < 40; i++) {
  const rng = rngOf(500 + i)
  const n = int(rng, 0, 14)
  const { rows: autos, referenced } = candidates(rng, n)
  const cap = int(rng, 0, 8)
  push({
    op: 'autoVersionsOverCap',
    tag: `cap-${cap}`,
    autos,
    referenced,
    cap,
    result: answer(() => autoVersionsOverCap(autos, new Set(referenced), cap)),
  })
  const carried = autos.filter(() => rng() < 0.5).map((r) => r.id)
  push({
    op: 'carriedAutoVersionsOverCap',
    tag: `cap-${cap}`,
    autos,
    carried,
    referenced,
    cap,
    result: answer(() =>
      carriedAutoVersionsOverCap(autos, new Set(carried), new Set(referenced), cap),
    ),
  })
  const sandwich = autos.map((row) => ({ ...row, auto: rng() < 0.6 }))
  push({
    op: 'sandwichedAutoVersionIds',
    tag: `n-${n}`,
    candidates: sandwich,
    result: answer(() => sandwichedAutoVersionIds(sandwich)),
  })
}
push({
  op: 'autoVersionsOverCap',
  tag: 'default-cap',
  autos: Array.from({ length: MAX_AUTO_PER_DOCUMENT + 3 }, (_, i) => ({
    id: `v${i}`,
    restoredFrom: null,
  })),
  referenced: [],
  result: answer(() =>
    autoVersionsOverCap(
      Array.from({ length: MAX_AUTO_PER_DOCUMENT + 3 }, (_, i) => ({
        id: `v${i}`,
        restoredFrom: null,
      })),
      new Set(),
    ),
  ),
})
for (const id of ['v1', 'a-b', '']) {
  push({
    op: 'restorePointOptions',
    tag: id,
    restoredFrom: id,
    result: answer(() => restorePointOptions(id)),
  })
}
push({
  op: 'constants',
  tag: 'limits',
  result: {
    ok: {
      MAX_AUTO_PER_DOCUMENT,
      MAX_MANUAL_PER_DOCUMENT,
      MAX_RESTORE_POINTS_PER_DOCUMENT,
      CHECKPOINT_QUIET_MS,
    },
  },
})

writeFileSync(OUT, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`)
console.log(`wrote ${rows.length} rows to ${OUT}`)
