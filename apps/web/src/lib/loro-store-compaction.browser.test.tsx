/**
 * Compaction, against real IndexedDB and real Loro bytes.
 *
 * jsdom has neither, and the property under test is precisely that the bytes
 * a fresh open replays stop growing — which is only observable once both are
 * real.
 */
import { readSpatialCanvas, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { expect, it } from 'vitest'
import { COMPACT_DELTA_BYTES } from './loro-compaction.js'
import { LoroStore } from './loro-store.js'

function canvasWith(n: number, nudge = 0): SpatialCanvas {
  return {
    nodes: Array.from({ length: n }, (_, i) => ({
      id: `n${i}`,
      type: 'text' as const,
      x: (i % 10) * 220 + nudge,
      y: Math.floor(i / 10) * 140,
      width: 200,
      height: 120,
      text: `Node ${i} — a line of text long enough to be realistic.`,
    })),
    edges: [],
  } as SpatialCanvas
}

function totalBytes(deltas: readonly Uint8Array[] | undefined): number {
  return (deltas ?? []).reduce((sum, d) => sum + d.byteLength, 0)
}

it('folds the delta log once it passes the budget, keeping the content', async () => {
  const store = new LoroStore()
  const id = `doc-${Math.trunc(performance.now() * 1000)}`

  const doc = new LoroDoc()
  writeSpatialCanvas(doc, canvasWith(20))
  doc.commit()
  await store.save(id, doc.export({ mode: 'snapshot' }))

  let version = doc.version()
  let appended = 0
  let pushed = 0
  // Past the budget with room to spare, so the assertion is not on its edge.
  while (pushed < COMPACT_DELTA_BYTES * 2) {
    appended += 1
    if (appended > 2000) throw new Error('never reached the budget')
    writeSpatialCanvas(doc, canvasWith(20, appended))
    doc.commit()
    const delta = doc.export({ mode: 'update', from: version })
    version = doc.version()
    pushed += delta.byteLength
    await store.appendDelta(id, delta)
  }

  const loaded = await store.load(id)
  expect(loaded.kind).toBe('ok')
  if (loaded.kind !== 'ok') return

  // The log is folded away, not merely trimmed.
  expect(totalBytes(loaded.deltas)).toBeLessThanOrEqual(COMPACT_DELTA_BYTES)

  // And the content survived the fold: the last edit is still there.
  const reopened = new LoroDoc()
  reopened.import(loaded.snapshot)
  for (const d of loaded.deltas ?? []) reopened.import(d)
  expect(readSpatialCanvas(reopened).nodes[0]?.x).toBe(canvasWith(20, appended).nodes[0]?.x)
}, 120_000)
