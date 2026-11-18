import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import type { CoreSvgAsk } from './canvas-core.js'

/** An envelope a picture is asked in; the function names the form. */
type PictureAsk = Omit<CoreSvgAsk, 'form'>

import { layoutMarkdownDocumentPicture, layoutSpatialCanvasPicture } from './core-picture.js'
import type { SpatialLayoutOptions } from './layout/layout-options.js'
import { layoutMarkdownDocument } from './layout/markdown-switch.js'
import { layoutSpatialCanvas } from './layout/spatial-canvas.js'
import { fakeLayoutCore } from './test-utils/fake-layout-core.js'
import { bodyName, PAST_THE_PARSER } from './test-utils/markdown-document-oracle/oracle.js'
import { noteOptionsOf, recordedSurface } from './test-utils/markdown-document-oracle/replay.js'
import { built } from './test-utils/wasm/glue.js'
import { layoutCases } from './test-utils/wasm/layout-cases.js'
import { oracleLayoutCore } from './test-utils/wasm/oracle-layout-core.js'

/**
 * A server picture in ONE core call is the picture of the scene the plain
 * layout answers: the same scene, for every layout case and every recorded
 * note, in each envelope a server caller asks for - `wb_scene_render`'s
 * document view box, the `canvas_view` picture's derived envelope on a
 * palette's paper, and the file export's padding, dark text fill and raster
 * scale. That the SVG is the core's backend over that scene, byte for byte, is
 * held in the core's own tests (`svg_tests.rs`, `svg_form_tests.rs`); this
 * holds that the envelope asked for is the one drawn.
 */
const ASKS: readonly (readonly [string, PictureAsk])[] = [
  ['scene-render', { viewBox: 'document' }],
  ['view-picture', { padding: 0, background: '#ffffff' }],
  ['export-light', { padding: 16, background: '#fafafa', rasterScale: 1 }],
  ['export-dark', { padding: 16, background: '#1e1e1e', rasterScale: 3, textFill: '#e6e6e6' }],
]

/** The SVG is a document, painted on the paper the ask named when it named one. */
function expectEnvelope(svg: string | undefined, ask: PictureAsk, label: string): void {
  expect(svg?.startsWith('<svg '), label).toBe(true)
  if (ask.background !== undefined) expect(svg, label).toContain(`fill="${ask.background}"`)
}

describe.runIf(built)('a picture in one core call', () => {
  it('draws every layout case with the scene the plain layout answers', {
    timeout: 60_000,
  }, () => {
    const core = oracleLayoutCore()
    let compared = 0
    for (const { name, canvas, options } of layoutCases(8)) {
      const laid = (o: Omit<SpatialLayoutOptions, 'core'>) => ({ ...o, core })
      const scene = layoutSpatialCanvas(canvas, laid(options))
      for (const [label, ask] of ASKS) {
        const picture = layoutSpatialCanvasPicture(canvas, laid(options), ask)
        expect(picture.scene, `${name} ${label}`).toEqual(scene)
        expectEnvelope(picture.svg, ask, `${name} ${label}`)
        compared += 1
      }
    }
    expect(compared, 'canvas pictures compared').toBeGreaterThan(600)
  })

  // Ceiling: the run measured 26s here; the markdown replay beside it takes 120s for the same reason.
  const NOTES_TIMEOUT_MS = 180_000
  it('draws every recorded note with the scene the plain layout answers', {
    timeout: NOTES_TIMEOUT_MS,
  }, () => {
    const core = fakeLayoutCore({ markdown: oracleLayoutCore().markdown })
    let compared = 0
    for (const name of ['daemon', 'preview', 'outline', 'thumbnail'] as const) {
      const { meta, records } = recordedSurface(name)
      for (const record of records) {
        // A body past the parser's bounds is drawn as its literal text either way.
        if (PAST_THE_PARSER.has(bodyName(record.id))) continue
        const options = { ...noteOptionsOf(record, meta), core }
        const scene = layoutMarkdownDocument(record.body, options)
        for (const [label, ask] of ASKS) {
          const picture = layoutMarkdownDocumentPicture(record.body, options, ask)
          if (scene === undefined) {
            expect(picture, `${record.id} ${label}`).toBeUndefined()
            continue
          }
          expect(picture?.scene, `${record.id} ${label}`).toEqual(scene)
          expectEnvelope(picture?.svg, ask, `${record.id} ${label}`)
          compared += 1
        }
      }
    }
    expect(compared, 'note pictures compared').toBeGreaterThan(1400)
  })

  it('draws a refusal the core did not lay out in the envelope asked for', () => {
    const core = oracleLayoutCore()
    const boxes = Array.from({ length: 4097 }, (_, i) => ({
      id: `n${i}`,
      x: i * 10,
      y: 0,
      width: 8,
      height: 8,
    }))
    const canvas = { nodes: boxes, edges: [] } as unknown as SpatialCanvas
    const [first] = layoutCases(1)
    if (first === undefined) throw new Error('no layout cases')
    const refused: string[] = []
    const options = {
      ...first.options,
      core,
      onRefused: (r: { reason: string }) => refused.push(r.reason),
    }
    const ask: PictureAsk = { viewBox: 'document', background: '#ffffff' }
    const picture = layoutSpatialCanvasPicture(canvas, options, ask)
    expect(refused).toEqual(['too-many-elements'])
    expectEnvelope(picture.svg, ask, 'the refusal')
  })
})
