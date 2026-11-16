import type { BoundingBox } from '@kamiazya/whiteboard-scene'
import { BUNDLED_SHAPE_TABLE, outlineContentBox } from '../../layout/nodes/node-outline.js'
import { hex } from '../compose-canvas-oracle/oracle.js'

/**
 * The recorded answers of `outlineContentBox` (ADR-0054 step 7, S18a), the
 * box the editor's markdown overlay is placed in over a shaped node: every
 * bundled silhouette, no silhouette and an unknown one, over boxes square,
 * wide, tall, fractional, degenerate and not finite, at the origin and far
 * from it. Every double is the hex of its bits.
 */

export interface OutlineContentBoxRecord {
  readonly shape: string | null
  readonly box: readonly string[]
  readonly answer: readonly string[]
}

const fromHex = (h: string): number =>
  new Float64Array(new BigUint64Array([BigInt(`0x${h}`)]).buffer)[0] ?? Number.NaN

const boxHex = (b: BoundingBox) => [hex(b.x), hex(b.y), hex(b.w), hex(b.h)]

export function outlineContentBoxAnswer(
  record: Omit<OutlineContentBoxRecord, 'answer'>,
): OutlineContentBoxRecord {
  const [x, y, w, h] = record.box.map(fromHex)
  const inner = outlineContentBox(record.shape ?? undefined, {
    x: x ?? 0,
    y: y ?? 0,
    w: w ?? 0,
    h: h ?? 0,
  })
  return { ...record, answer: boxHex(inner) }
}

const BOXES: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 200, 100],
  [0, 0, 100, 100],
  [0, 0, 100, 300],
  [0, 0, 640, 40],
  [12.5, -7.25, 181.75, 93.5],
  [-4000, 9000, 220, 140],
  [2 ** 40, -(2 ** 40), 333, 77],
  [0, 0, 1, 1],
  [0, 0, 0, 0],
  [0, 0, 0, 80],
  [0, 0, -50, 40],
  [Number.NaN, 0, 100, 100],
  [0, 0, Number.POSITIVE_INFINITY, 100],
]

/** Every record, in file order. */
export function outlineContentBoxRecords(): readonly OutlineContentBoxRecord[] {
  const shapes = [...Object.keys(BUNDLED_SHAPE_TABLE), null, 'visual.nonesuch', 'other.ellipse']
  return shapes.flatMap((shape) =>
    BOXES.map(([x, y, w, h]) =>
      outlineContentBoxAnswer({ shape, box: [hex(x), hex(y), hex(w), hex(h)] }),
    ),
  )
}
