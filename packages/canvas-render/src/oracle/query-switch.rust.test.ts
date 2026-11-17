import { readFileSync } from 'node:fs'
import { type Core, type CoreGlue, coreFrom } from '@kamiazya/whiteboard-core-wasm'
import type { SpatialNode } from '@kamiazya/whiteboard-model'
import type { BoundingBox, SceneNode } from '@kamiazya/whiteboard-scene'
import { beforeAll, describe, expect, it } from 'vitest'
import { fittedTextNodeHeight } from '../layout/fitted-height.js'
import {
  queryCommentBubble,
  queryEdgeLabelPlacement,
  queryLabelObstacles,
  queryOutlineContentBox,
} from '../layout/queries.js'
import { layoutSpatialEdges, naturalNodeContentSize } from '../layout/spatial-canvas.js'
import type { LayoutCore } from '../layout-core.js'
import { fakeLayoutCore } from '../test-utils/fake-layout-core.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { editorOptions } from '../test-utils/query-oracle/boards.js'
import type { EdgesRecord } from '../test-utils/query-oracle/edges.js'
import type { LabelPlacementRecord } from '../test-utils/query-oracle/label-placement.js'
import type { NodeSizeRecord } from '../test-utils/query-oracle/node-size.js'
import type { OutlineContentBoxRecord } from '../test-utils/query-oracle/outline-content-box.js'
import { hex } from '../test-utils/render-oracle/scene-dump.js'
import { answerText } from '../test-utils/wasm/answer-text.js'
import { built, requireWasm, wasmBytes } from '../test-utils/wasm/glue.js'
import { createSpatialTheme } from '../theme/spatial-theme.js'

/**
 * S18a's query recordings through canvas-render's queries over the REAL core,
 * as the editors, the drag layers and `wb_canvas_edit` ask: the core's answer
 * is what the caller gets, and it is the recorded one, but for the bodies past
 * the parser's bounds, which it sizes as their literal text (owner decision
 * q81, D7a) and which must differ. Every caller hands its arguments as data.
 */
const DIR = new URL('./', import.meta.url)

function records<T>(name: string): T[] {
  const lines = readFileSync(new URL(`${name}.jsonl`, DIR), 'utf8')
    .trimEnd()
    .split('\n')
  return lines.map((line) => JSON.parse(line) as T)
}

const fromHex = (h: string): number =>
  new Float64Array(new BigUint64Array([BigInt(`0x${h}`)]).buffer)[0] ?? Number.NaN
const box = ([x, y, w, h]: readonly string[]): BoundingBox => ({
  x: fromHex(x ?? ''),
  y: fromHex(y ?? ''),
  w: fromHex(w ?? ''),
  h: fromHex(h ?? ''),
})
const boxHex = (b: BoundingBox) => [hex(b.x), hex(b.y), hex(b.w), hex(b.h)]

/** The bodies the parser refuses: the core sizes a node holding one as the literal text it draws. */
const TOLERATED = ['quote 33 deep', 'list 39 deep', 'list 40 deep']

describe.runIf(built)('the recorded queries through the core', () => {
  // Made in `beforeAll`, not in this factory: vitest runs a skipped suite's
  // factory to collect it, so a core made here fails the file where there is
  // no artifact instead of skipping it.
  let real: Core
  beforeAll(() => {
    real = coreFrom(requireWasm() as unknown as CoreGlue, wasmBytes())
  })

  /** `ask` of the real core's query entry, and whether the core refused it. */
  function through<T>(ask: (core: LayoutCore) => T) {
    let refused: string | undefined
    const core = fakeLayoutCore({
      query: {
        layoutQuery(...args) {
          const answer = real.layoutQuery(...args)
          refused = 'refused' in answer ? answer.refused.reason : undefined
          return answer
        },
      },
    })
    return { rust: ask(core), refused }
  }

  /** `ask` of the real core, which must answer it. */
  function both<T>(ask: (core: LayoutCore) => T) {
    const out = through(ask)
    expect(out.refused).toBeUndefined()
    return out
  }

  it('lays out every recorded drag frame as recorded', { timeout: 120_000 }, () => {
    const all = records<EdgesRecord>('layout-spatial-edges')
    expect(all.length).toBe(240)
    for (const record of all) {
      const ask = (core: LayoutCore) =>
        layoutSpatialEdges(record.canvas, {
          ...editorOptions(record.profile),
          edgeSideOverrides: new Map(record.overrides),
          core,
        })
      const { rust } = both(ask)
      // The core writes a scene's keys in its own order; every value is held, -0 included.
      expect(JSON.parse(answerText(rust) ?? 'null'), record.id).toEqual(JSON.parse(record.answer))
    }
  })

  it('sizes every recorded node as recorded', { timeout: 120_000 }, () => {
    const all = records<NodeSizeRecord>('node-size')
    expect(all.length).toBe(236)
    let tolerated = 0
    for (const record of all) {
      const literal = TOLERATED.some((name) => record.id.includes(`/${name}@`))
      if (literal) tolerated += 1
      const measure = createFakeMeasure()
      const appearance = createSpatialTheme({ mode: record.mode })
      const ask = (core: LayoutCore): readonly number[] => {
        if (record.kind === 'fitted') {
          return [
            fittedTextNodeHeight(record.node, { measure, appearance, floor: record.floor, core }),
          ]
        }
        const fonts = new Set(record.fonts ?? [])
        const { w, h } = naturalNodeContentSize(record.node, {
          measure,
          appearance,
          core,
          ...(record.style === undefined ? {} : { style: record.style }),
          ...(record.fonts === undefined ? {} : { fontAvailable: (f: string) => fonts.has(f) }),
          ...(record.fragments === undefined ? {} : { fragments: record.fragments }),
        })
        return [w, h]
      }
      const { rust, refused } = through(ask)
      expect(refused, record.id).toBeUndefined()
      if (literal) {
        expect(rust.map(hex), record.id).not.toEqual(record.answer)
      } else {
        expect(rust.map(hex), record.id).toEqual(record.answer)
      }
    }
    expect(tolerated).toBe(24)
  })

  it('places every recorded label, and finds every recorded obstacle', { timeout: 120_000 }, () => {
    const all = records<LabelPlacementRecord>('edge-label-placement')
    expect(all.length).toBe(272)
    for (const record of all) {
      if (record.kind === 'obstacles') {
        const ask = (core: LayoutCore) =>
          queryLabelObstacles(core, record.nodes as SpatialNode[], record.runs as SceneNode[])
        const { rust } = both(ask)
        expect(rust.titles.map(boxHex), record.id).toEqual(record.titles)
        expect(rust.obstacles.map(boxHex), record.id).toEqual(record.answer)
        continue
      }
      const path = record.path.map(([x, y]) => ({ x: fromHex(x ?? ''), y: fromHex(y ?? '') }))
      const [w, h] = record.size.map(fromHex)
      const size = { w: w ?? 0, h: h ?? 0 }
      const ask = (core: LayoutCore) =>
        queryEdgeLabelPlacement(core, path, size, record.obstacles.map(box), record.rounded)
      const { rust } = both(ask)
      expect(rust === undefined ? null : [hex(rust.x), hex(rust.y)], record.id).toEqual(
        record.answer,
      )
    }
  })

  it('places every recorded compose bubble', () => {
    type Place = {
      kind: string
      anchor: string[]
      size: string[]
      obstacles: string[][]
      answer: string[]
    }
    const all = records<Place>('comment-placement').filter((r) => r.kind === 'place')
    expect(all.length).toBe(235)
    for (const record of all) {
      const [x, y] = record.anchor.map(fromHex)
      const [w, h] = record.size.map(fromHex)
      const ask = (core: LayoutCore) =>
        queryCommentBubble(
          core,
          { x: x ?? 0, y: y ?? 0 },
          { w: w ?? 0, h: h ?? 0 },
          record.obstacles.map(box),
        )
      expect(boxHex(both(ask).rust)).toEqual(record.answer)
    }
  })

  it('inscribes every recorded content box', () => {
    const all = records<OutlineContentBoxRecord>('outline-content-box')
    expect(all.length).toBe(117)
    for (const record of all) {
      const ask = (core: LayoutCore) =>
        queryOutlineContentBox(core, record.shape ?? undefined, box(record.box))
      expect(boxHex(both(ask).rust)).toEqual(record.answer)
    }
  })
})
