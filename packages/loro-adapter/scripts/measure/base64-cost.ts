/**
 * What the contract's base64 spelling of bytes costs against the work the bytes
 * are for: encode and decode of a snapshot near 10 MB, beside opening it,
 * exporting it and importing an update of it.
 *
 *   pnpm --filter @kamiazya/whiteboard-mcp exec tsx \
 *     ../loro-adapter/scripts/measure/base64-cost.ts [megabytes]
 *
 * Each figure is the median of five runs after one warm-up, in milliseconds.
 */
import { base64ToBytes, bytesToBase64 } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { createCrdtEngine } from '../../src/engine/engine.js'

const TARGET_BYTES = Number(process.argv[2] ?? 10) * 1024 * 1024

/** Random text does not compress, so the snapshot's size is close to what is written. */
function snapshotNear(target: number): Uint8Array {
  const doc = new LoroDoc()
  const nodes = doc.getMap('nodes')
  let seed = 1
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed
  }
  const noise = () =>
    Array.from({ length: 200 }, () => String.fromCharCode(33 + (next() % 90))).join('')
  let size = 0
  for (let i = 0; size < target; i++) {
    for (let j = 0; j < 500; j++) nodes.set(`n${i}-${j}`, { text: noise(), x: next(), y: next() })
    doc.commit()
    size = doc.export({ mode: 'snapshot' }).byteLength
  }
  return doc.export({ mode: 'snapshot' })
}

function median(run: () => unknown): number {
  run()
  const times = Array.from({ length: 5 }, () => {
    const start = performance.now()
    run()
    return performance.now() - start
  }).sort((a, b) => a - b)
  return times[2] ?? 0
}

const snapshot = snapshotNear(TARGET_BYTES)
const encoded = bytesToBase64(snapshot)
const engine = createCrdtEngine()
const source = engine.open({ peer: '1', bytes: encoded })
const update = engine.export({ handle: source.handle, mode: 'update' }).bytes

const rows: Array<[string, number]> = [
  ['base64 encode of the snapshot', median(() => bytesToBase64(snapshot))],
  ['base64 decode of the snapshot', median(() => base64ToBytes(encoded))],
  [
    'open from base64 (decode + import)',
    median(() => engine.close({ handle: engine.open({ peer: '2', bytes: encoded }).handle })),
  ],
  [
    'LoroDoc.import of the raw bytes',
    median(() => {
      const doc = new LoroDoc()
      doc.import(snapshot)
      doc.free()
    }),
  ],
  [
    'export snapshot as base64',
    median(() => engine.export({ handle: source.handle, mode: 'snapshot' })),
  ],
  [
    'import of a full-history update',
    median(() => {
      const { handle } = engine.open({ peer: '3' })
      engine.import({ handle, bytes: update, judge: 'none' })
      engine.close({ handle })
    }),
  ],
]

process.stdout.write(
  `snapshot ${(snapshot.byteLength / 1048576).toFixed(2)} MB, base64 ${(encoded.length / 1048576).toFixed(2)} MB\n`,
)
for (const [label, ms] of rows) process.stdout.write(`${label.padEnd(40)} ${ms.toFixed(1)} ms\n`)
