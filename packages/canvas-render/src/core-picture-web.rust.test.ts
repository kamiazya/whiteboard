import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { Scene } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import type { CoreKeyedSvg, CoreSvgAsk } from './canvas-core.js'

/** An envelope a picture is asked in; the function names the form. */
type PictureAsk = Omit<CoreSvgAsk, 'form'>

import {
  layoutCommentDocumentKeyedPicture,
  layoutMarkdownDocumentKeyedPicture,
  layoutSpatialCanvasKeyedPicture,
  layoutSpatialCanvasPicture,
  layoutSpatialEdgesPicture,
} from './core-picture.js'
import type { EdgeAnchorOverride } from './edge-routing.js'
import type { SpatialLayoutOptions } from './layout/layout-options.js'
import { layoutCommentDocument, layoutMarkdownDocument } from './layout/markdown-switch.js'
import {
  layoutSpatialCanvas,
  layoutSpatialCanvasWithAnchors,
  layoutSpatialEdges,
} from './layout/spatial-canvas.js'
import { sceneBounds, sceneDocumentBounds } from './scene-bounds.js'
import { fakeLayoutCore } from './test-utils/fake-layout-core.js'
import { createFakeMeasure } from './test-utils/fake-measure.js'
import { bodyName, PAST_THE_PARSER } from './test-utils/markdown-document-oracle/oracle.js'
import { noteOptionsOf, recordedSurface } from './test-utils/markdown-document-oracle/replay.js'
import { built } from './test-utils/wasm/glue.js'
import { layoutCases } from './test-utils/wasm/layout-cases.js'
import { oracleLayoutCore } from './test-utils/wasm/oracle-layout-core.js'

/**
 * The web's pictures in ONE core call (ADR-0054 A3.1) are the pictures its
 * callers draw: each ask below is held, over every layout case and every
 * recorded note and comment, to the scene the plain layout answers and to the
 * envelope the caller it stands for wants, spelled here from the caller
 * rather than imported:
 *
 * - the editor surface (`scene-render-core.ts`'s `documentEnvelope`, plain
 *   and keyed): the view box is `sceneBounds`, legend omitted;
 * - the saved picture (`renderCanvasForExportWith`): the view box is
 *   `sceneDocumentBounds(scene, 16)`, with or without paper;
 * - the version viewer (`CanvasViewer`): `{width?, height?, padding, background}`;
 * - the drag overlay (`use-drag-layers.ts`'s `liveEdges`): the edge layer as a
 *   scene of its own, the view box its `sceneBounds`;
 * - the preview pane (`renderMarkdownPreview`): keyed, `{padding: 8, background?}`;
 * - a comment's body (`CommentBody`): keyed, `{padding: 1}`.
 *
 * That the SVG is the core's backend over that scene, byte for byte, is held in
 * the core's own tests (`svg_tests.rs`, `svg_form_tests.rs`, `svg_oracle.rs`).
 */
interface Box {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** The view box (and the size that goes with it) an ask's caller wants, or none to check. */
type Envelope = (scene: Scene) => Box | undefined

/** The root `<svg …>` open tag's `name` attribute. */
const attrOf = (svg: string, name: string): string | undefined =>
  new RegExp(`^<svg [^>]*?\\b${name}="([^"]*)"`).exec(svg)?.[1]

/** The SVG's root carries the view box and size of `box`, and the paper of `ask`, when it names them. */
function expectEnvelope(svg: string, ask: PictureAsk, box: Box | undefined, label: string): void {
  expect(svg.startsWith('<svg '), label).toBe(true)
  if (box !== undefined) {
    const viewBox = (attrOf(svg, 'viewBox') ?? '').split(' ').map(Number)
    const wanted = [box.x, box.y, box.w, box.h]
    expect(viewBox.length, `${label} viewBox`).toBe(4)
    for (const [i, value] of wanted.entries()) {
      expect(viewBox[i], `${label} viewBox[${i}]`).toBeCloseTo(value, 3)
    }
    expect(Number(attrOf(svg, 'width')), `${label} width`).toBeCloseTo(box.w, 3)
    expect(Number(attrOf(svg, 'height')), `${label} height`).toBeCloseTo(box.h, 3)
  }
  if (ask.width !== undefined) expect(attrOf(svg, 'width'), `${label} width`).toBe(`${ask.width}`)
  if (ask.height !== undefined) {
    expect(attrOf(svg, 'height'), `${label} height`).toBe(`${ask.height}`)
  }
  if (ask.background !== undefined) expect(svg, label).toContain(`fill="${ask.background}"`)
}

/** A keyed projection's root and groups are the envelope's, and its document text opens with its root. */
function expectKeyed(
  keyed: CoreKeyedSvg | undefined,
  ask: PictureAsk,
  box: Box | undefined,
  label: string,
): void {
  expect(keyed, label).toBeDefined()
  if (keyed === undefined) return
  expectEnvelope(keyed.svg, ask, box, label)
  expect(keyed.svg.startsWith(keyed.rootOpen), label).toBe(true)
  expect(
    keyed.groups.every((group) => keyed.svg.includes(group.svg)),
    label,
  ).toBe(true)
}

const EDGES_ASK: PictureAsk = { viewBox: { of: 'scene' } }
const EDITOR_ASK: PictureAsk = { viewBox: { of: 'scene' }, legend: 'omit' }
const editorEnvelope: Envelope = (scene) => sceneBounds(scene)

const CANVAS_ASKS: readonly (readonly [string, PictureAsk, Envelope])[] = [
  ['editor', EDITOR_ASK, editorEnvelope],
  ['export', { viewBox: { of: 'document', margin: 16 } }, (s) => sceneDocumentBounds(s, 16)],
  [
    'export-paper',
    { viewBox: { of: 'document', margin: 16 }, background: '#ffffff' },
    (s) => sceneDocumentBounds(s, 16),
  ],
  ['viewer-sized', { width: 640, height: 480, padding: 0, background: '#fafafa' }, () => undefined],
  ['viewer-host-sized', { padding: 12 }, () => undefined],
  // No caller yet: the scene's own bounds grown by a margin, the one shape left.
  [
    'scene-margin',
    { viewBox: { of: 'scene', margin: 10 } },
    (s) => {
      const { x, y, w, h } = sceneBounds(s)
      return { x: x - 10, y: y - 10, w: w + 20, h: h + 20 }
    },
  ],
]

describe.runIf(built)("the web's pictures in one core call", () => {
  it('draws every layout case in each canvas envelope the web asks for', {
    timeout: 120_000,
  }, () => {
    const core = oracleLayoutCore()
    let compared = 0
    for (const { name, canvas, options } of layoutCases(8)) {
      const laid = (o: Omit<SpatialLayoutOptions, 'core'>) => ({ ...o, core })
      const { scene, anchors } = layoutSpatialCanvasWithAnchors(canvas, laid(options))
      for (const [label, ask, envelope] of CANVAS_ASKS) {
        const picture = layoutSpatialCanvasPicture(canvas, laid(options), ask)
        expect(picture.scene, `${name} ${label}`).toEqual(scene)
        expect(picture.anchors, `${name} ${label}`).toEqual(anchors)
        expectEnvelope(picture.svg, ask, envelope(scene), `${name} ${label}`)
        compared += 1
      }
      const keyed = layoutSpatialCanvasKeyedPicture(canvas, laid(options), EDITOR_ASK)
      expect(keyed.scene, `${name} keyed`).toEqual(scene)
      expect(keyed.anchors, `${name} keyed`).toEqual(anchors)
      expectKeyed(keyed.keyed, EDITOR_ASK, editorEnvelope(scene), `${name} keyed`)
      compared += 1
    }
    expect(compared, 'canvas pictures compared').toBeGreaterThan(1200)
  })

  it('draws every drag overlay frame as the layer the overlay draws today', {
    timeout: 120_000,
  }, () => {
    const core = oracleLayoutCore()
    let compared = 0
    let drawn = 0
    for (const { name, canvas, options } of layoutCases(8)) {
      const laid = { ...options, core }
      const { scene, anchors } = layoutSpatialCanvasWithAnchors(canvas, laid)
      // The overlay's bystanders pinned at the committed anchors, as a drag pins them.
      const pinned = new Map<string, EdgeAnchorOverride>()
      for (const node of scene.nodes) {
        if (node.kind !== 'edge') continue
        pinned.set(node.id, {
          fromSide: node.fromSide,
          toSide: node.toSide,
          ...anchors.get(node.id),
        })
      }
      for (const [label, frame] of [
        ['free', laid],
        ['pinned', { ...laid, edgeSideOverrides: pinned }],
      ] as const) {
        const nodes = layoutSpatialEdges(canvas, frame)
        const picture = layoutSpatialEdgesPicture(canvas, frame, EDGES_ASK)
        expect(picture.nodes, `${name} ${label}`).toEqual(nodes)
        expectEnvelope(picture.svg, EDGES_ASK, sceneBounds({ nodes }), `${name} ${label}`)
        compared += 1
        if (nodes.length > 0) drawn += 1
      }
    }
    expect(compared, 'overlay frames compared').toBeGreaterThan(200)
    expect(drawn, 'overlay frames drawing an edge').toBeGreaterThan(100)
  })

  const NOTES_TIMEOUT_MS = 180_000
  it('draws every recorded note as the preview pane draws its keyed projection', {
    timeout: NOTES_TIMEOUT_MS,
  }, () => {
    const core = fakeLayoutCore({ markdown: oracleLayoutCore().markdown })
    let compared = 0
    for (const name of ['daemon', 'preview', 'outline', 'thumbnail'] as const) {
      const { meta, records } = recordedSurface(name)
      for (const record of records) {
        if (PAST_THE_PARSER.has(bodyName(record.id))) continue
        const options = { ...noteOptionsOf(record, meta), core }
        const scene = layoutMarkdownDocument(record.body, options)
        for (const background of [undefined, '#ffffff']) {
          const ask = { padding: 8, ...(background === undefined ? {} : { background }) }
          const picture = layoutMarkdownDocumentKeyedPicture(record.body, options, ask)
          if (scene === undefined) {
            expect(picture, record.id).toBeUndefined()
            continue
          }
          expect(picture?.scene, record.id).toEqual(scene)
          expectKeyed(picture?.keyed, ask, undefined, record.id)
          compared += 1
        }
      }
    }
    expect(compared, 'note projections compared').toBeGreaterThan(700)
  })

  it('draws every recorded comment as its body draws its keyed projection', () => {
    const core = fakeLayoutCore({ markdown: oracleLayoutCore().markdown })
    const { records } = recordedSurface('comment')
    let compared = 0
    for (const record of records) {
      const options = {
        measure: createFakeMeasure(),
        maxWidth: record.maxWidth,
        density: record.density ?? 'comfortable',
        core,
      }
      const scene = layoutCommentDocument(record.body, options)
      const picture = layoutCommentDocumentKeyedPicture(record.body, options, { padding: 1 })
      expect(picture.scene, record.id).toEqual(scene)
      expectKeyed(picture.keyed, { padding: 1 }, undefined, record.id)
      compared += 1
    }
    expect(compared, 'comment projections compared').toBeGreaterThan(40)
  })

  it('draws what the core refused in the envelope and form asked for', () => {
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
    const keyed = layoutSpatialCanvasKeyedPicture(canvas, options, EDITOR_ASK)
    expect(refused).toEqual(['too-many-elements'])
    for (const [label, ask, envelope] of CANVAS_ASKS) {
      const picture = layoutSpatialCanvasPicture(canvas, options, ask)
      expectEnvelope(picture.svg, ask, envelope(picture.scene), label)
    }
    expect(keyed.scene).toEqual(layoutSpatialCanvas(canvas, options))
    expectKeyed(keyed.keyed, EDITOR_ASK, editorEnvelope(keyed.scene), 'the refusal')
    expect(keyed.keyed.groups.length).toBeGreaterThan(0)
    // A refused edge layer is no edges, and the core drew no picture of it:
    // an empty one that takes no room where it lands.
    const layer = layoutSpatialEdgesPicture(canvas, options, EDGES_ASK)
    expect(layer.nodes).toEqual([])
    expect(layer.svg).toBe('<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0"></svg>')
  })

  it('lays a board out whose paint carries a character the wire cannot', () => {
    const core = oracleLayoutCore()
    const [first] = layoutCases(1)
    if (first === undefined) throw new Error('no layout cases')
    const refused: string[] = []
    const options = {
      ...first.options,
      core,
      onRefused: (r: { reason: string }) => refused.push(r.reason),
    }
    const ask = { padding: 0, background: 'red\uD800', textFill: '\uDC00blue' }
    const picture = layoutSpatialCanvasPicture(first.canvas, options, ask)
    expect(refused).toEqual([])
    expectEnvelope(picture.svg, { padding: 0, background: 'red' }, undefined, 'the board')
    expect(picture.svg).not.toMatch(/[\uD800-\uDFFF]/)
  })
})
