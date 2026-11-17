import { readdirSync, readFileSync } from 'node:fs'
import { type Core, type CoreGlue, coreFrom } from '@kamiazya/whiteboard-core-wasm'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { beforeAll, describe, expect, it } from 'vitest'
import type { CanvasLayoutCore, CanvasLayoutRequest } from '../../canvas-core.js'
import type { FragmentAsk } from '../../fragment-ask.js'
import type { SpatialLayoutDegradation, SpatialLayoutOptions } from '../../layout/layout-options.js'
import { layoutSpatialCanvasWithAnchors } from '../../layout/spatial-canvas.js'
import { describeMeasure, type MeasureText } from '../../measure.js'
import { type LayoutRefusal, refusalScene } from '../../refusal.js'
import { fakeLayoutCore } from '../fake-layout-core.js'
import { answerText } from './answer-text.js'
import { built, requireWasm, wasmBytes } from './glue.js'
import { layoutCases } from './layout-cases.js'

/**
 * The whole layout through the REAL core (ADR-0054 step 7): canvas-render's
 * `layoutSpatialCanvasWithAnchors` handed the core, which answers with its
 * `layout_spatial_canvas`, held to the scene, the anchors, the degradations
 * and the fragment sources the TypeScript composer drew for the same cases
 * before it was deleted (S18h), as `layout-spatial-canvas.<topic>.jsonl`
 * froze them. The layouts are `layout-cases.ts`.
 */
const DIR = new URL('./oracle/', import.meta.url)
const recordedAnswers = new Map(
  readdirSync(DIR)
    .filter((name) => /^layout-spatial-canvas\.[a-z0-9-]+\.jsonl$/.test(name))
    .flatMap((name) =>
      readFileSync(new URL(name, DIR), 'utf8')
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line) as { id: string; answer: string })
        .map((r) => [r.id, r.answer] as const),
    ),
)

/** A degradation as the recording spells it: a parse failure carries no thrown value. */
function recordedEvent(event: SpatialLayoutDegradation) {
  return event.kind === 'body-parse-failed' ? { kind: event.kind, nodeId: event.nodeId } : event
}

describe.runIf(built)('the whole layout through the real core', () => {
  // Made in `beforeAll`, not in this factory: vitest runs a skipped suite's
  // factory to collect it, so a core made here fails the file where there is
  // no artifact instead of skipping it.
  let real: Core
  beforeAll(() => {
    real = coreFrom(requireWasm() as unknown as CoreGlue, wasmBytes())
  })
  const answered = { compared: 0, refused: [] as string[] }
  const counting: CanvasLayoutCore = {
    layoutSpatialCanvas(request: CanvasLayoutRequest, highlight, measure) {
      const answer = real.layoutSpatialCanvas(request, highlight, measure)
      if ('refused' in answer) answered.refused.push(answer.refused.reason)
      else answered.compared += 1
      return answer
    },
  }
  const lay = (canvas: SpatialCanvas, options: Omit<SpatialLayoutOptions, 'core'>) =>
    layoutSpatialCanvasWithAnchors(canvas, {
      ...options,
      core: fakeLayoutCore({ routing: real, layout: counting }),
    })

  const cases = layoutCases(8)
  it('draws every case as the TypeScript drew it', () => {
    // Every case is recorded: one the recording lacks is a case the core is
    // held to nothing on, so it fails here by name rather than being skipped.
    const unrecorded = cases.map(({ name }) => name).filter((name) => !recordedAnswers.has(name))
    expect(unrecorded, 'cases with no recorded answer').toEqual([])
    let replayed = 0
    for (const { name, canvas, options } of cases) {
      const recorded = recordedAnswers.get(name) as string
      const events: unknown[] = []
      let asked: readonly FragmentAsk[] = []
      const tabled = options.fragments !== undefined || options.onFragmentsAsked !== undefined
      const rust = lay(canvas, {
        ...options,
        onDegrade: (event) => events.push(recordedEvent(event)),
        ...(tabled && { onFragmentsAsked: (asks: readonly FragmentAsk[]) => (asked = asks) }),
      })
      const tail = tabled ? [asked] : []
      // Compared as values: the recording spells keys in the order the
      // TypeScript built its objects, which no writer of the core's answer
      // repeats; `layout_oracle.rs` holds the core to it byte for byte.
      const answer = answerText(['ok', rust.scene, [...rust.anchors], events, ...tail])
      expect(JSON.parse(answer ?? 'null'), name).toEqual(JSON.parse(recorded))
      replayed += 1
    }
    expect(replayed, 'cases replayed').toBe(cases.length)
    expect(cases.length, 'the layout cases').toBeGreaterThan(100)
    // Every layout is answered: the core is judged, never refused.
    expect(answered.refused).toEqual([])
  })

  it('draws what it draws for a named measurer when the core asks the measurer itself', () => {
    answered.compared = 0
    let asked = 0
    for (const { name, canvas, options } of cases) {
      const own = options.measure
      const host: MeasureText = describeMeasure(
        (text, font) => {
          asked += 1
          return own(text, font)
        },
        { kind: 'host' },
      )
      const hosted = { ...options, measure: host }
      const reference = lay(canvas, options)
      const rust = lay(canvas, hosted)
      expect(rust.scene, name).toEqual(reference.scene)
      expect(Object.fromEntries(rust.anchors), name).toEqual(Object.fromEntries(reference.anchors))
    }
    expect(answered.refused).toEqual([])
    expect(asked, 'the host asked through the import').toBeGreaterThan(cases.length)
  })

  it('draws the refusal for a layout whose host answers a number that is not finite', () => {
    answered.refused.length = 0
    const [first] = cases
    if (first === undefined) throw new Error('no layout cases')
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const own = first.options.measure
      const host: MeasureText = describeMeasure(
        (text, font) => ({ ...own(text, font), ascent: bad }),
        { kind: 'host' },
      )
      const heard: LayoutRefusal[] = []
      const hosted = {
        ...first.options,
        measure: host,
        onRefused: (r: LayoutRefusal) => heard.push(r),
      }
      const rust = lay(first.canvas, hosted)
      const refused = { code: 'malformed', reason: 'host-measure' } as const
      expect(heard).toEqual([refused])
      const drawn = (['light', 'dark'] as const).map((mode) =>
        refusalScene(refused, { measure: host, mode }),
      )
      expect(drawn).toContainEqual(rust.scene)
      // Equal scenes can share one NaN, so the numbers are asked of directly.
      const baselines = rust.scene.nodes.flatMap((n) => (n.kind === 'textRun' ? [n.baseline] : []))
      expect(baselines.length).toBeGreaterThan(0)
      expect(baselines.every(Number.isFinite)).toBe(true)
    }
    // The core answered each with its refusal, which the surface drew.
    expect(answered.refused).toEqual(['host-measure', 'host-measure'])
  })
})
