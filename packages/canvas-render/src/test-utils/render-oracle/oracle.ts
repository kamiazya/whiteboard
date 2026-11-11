import type { CanvasEdge, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import type {
  MdastFlowContent,
  MdastPhrasingContent,
  MdastRoot,
} from '@kamiazya/whiteboard-model/mdast'
import { spatialCanvasArbitrary, textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { Scene } from '@kamiazya/whiteboard-scene'
import { layoutSpatialCanvas } from '../../layout/spatial-canvas.js'
import { sceneDigest } from '../../scene-digest.js'
import { renderSceneToSvg, type SvgDocumentOptions } from '../../svg/backend.js'
import { renderSceneToKeyedSvg } from '../../svg/keyed.js'
import { createSpatialTheme } from '../../theme/spatial-theme.js'
import { DRAWING_CORPUS } from '../drawing-corpus.js'
import { createFakeMeasure } from '../fake-measure.js'
import { fc } from '../fast-check.js'
import {
  buildDeterminismGoldenScene,
  buildShapeAppearanceGoldenScene,
  DETERMINISM_DOCUMENT_OPTIONS,
} from '../golden-scene.js'
import {
  buildArrowheadsScene,
  buildIconSetScene,
  buildJumpHopScene,
  buildNeonLookScene,
  buildNodeOutlinesScene,
  buildRoundedCornersScene,
  buildRoundedRectScene,
  buildSketchLookScene,
} from '../pixel-golden-scenes.js'
import {
  latticeLayouts,
  ROUTING_CORPUS,
  stackedFrameLayouts,
  syntheticLayouts,
} from '../routing-corpus.js'
import { CORPUS_WIDTHS_PX, TEXT_WRAPPING_CORPUS } from '../text-wrapping-corpus.js'
import { buildEveryKindScene } from './every-kind-scene.js'
import { dumpScene } from './scene-dump.js'

/**
 * The recorded answers of the TypeScript renderer, which the Rust slices
 * replay byte for byte (ADR-0054 decision 11): `render.jsonl` for the
 * composer, `svg.jsonl` for the SVG backend alone. The measurer is
 * `createFakeMeasure()`, body parsing and highlighting are the package's own
 * defaults, and the appearance is the bundled theme in the recorded mode, so
 * nothing in an answer depends on a host.
 *
 * A record holds its inputs as well as its answers, so re-computing needs no
 * corpus module and no generator: the files can be replayed by a crate that has
 * neither. Inputs pass through JSON before they are used, on the recording side
 * too, so what is answered is what a replay reads.
 */

interface RenderOptions {
  readonly mode: 'light' | 'dark'
  readonly style?: 'clean' | 'document'
}

export interface RenderRecord {
  readonly id: string
  readonly canvas: SpatialCanvas
  readonly options: RenderOptions
  /** `dumpScene` of the laid-out scene. */
  readonly scene: string
  readonly svg: string
  readonly keyed: ReturnType<typeof keyedAnswer>
  readonly digest: ReturnType<typeof sceneDigest>
}

export interface SvgRecord {
  readonly id: string
  readonly scene: Scene
  readonly options: SvgDocumentOptions | null
  readonly svg: string
  readonly keyed: ReturnType<typeof keyedAnswer>
}

export type RenderInput = Pick<RenderRecord, 'id' | 'canvas' | 'options'>
export type SvgInput = Pick<SvgRecord, 'id' | 'scene' | 'options'>

const viaJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function keyedAnswer(scene: Scene, options?: SvgDocumentOptions) {
  const { rootOpen, rootAttrs, groups } = renderSceneToKeyedSvg(scene, options)
  return { rootOpen, rootAttrs, groups }
}

function layoutRecorded(canvas: SpatialCanvas, options: RenderOptions): Scene {
  return layoutSpatialCanvas(canvas, {
    measure: createFakeMeasure(),
    appearance: createSpatialTheme({ mode: options.mode }),
    ...(options.style === undefined ? {} : { style: options.style }),
  })
}

export function renderAnswer(input: RenderInput): RenderRecord {
  const scene = layoutRecorded(input.canvas, input.options)
  return {
    id: input.id,
    canvas: input.canvas,
    options: input.options,
    scene: dumpScene(scene),
    svg: renderSceneToSvg(scene),
    keyed: keyedAnswer(scene),
    digest: sceneDigest(scene),
  }
}

export function svgAnswer(input: SvgInput): SvgRecord {
  const options = input.options ?? undefined
  return {
    id: input.id,
    scene: input.scene,
    options: input.options,
    svg: renderSceneToSvg(input.scene, options),
    keyed: keyedAnswer(input.scene, options),
  }
}

const inlineText = (node: MdastFlowContent | MdastPhrasingContent): string => {
  switch (node.type) {
    case 'text':
      return node.value
    case 'inlineCode':
      return `\`${node.value}\``
    case 'strong':
      return `**${node.children.map(inlineText).join('')}**`
    case 'paragraph':
      return node.children.map(inlineText).join('')
    case 'heading':
      return `${'#'.repeat(node.depth)} ${node.children.map(inlineText).join('')}`
    case 'list':
      return node.children.map((item) => `- ${item.children.map(inlineText).join('')}`).join('\n')
    default:
      throw new Error(`render-oracle: the wrapping corpus grew a ${node.type}`)
  }
}

/** A wrapping-corpus root as the markdown a text node would hold. */
const markdownOf = (root: MdastRoot): string => root.children.map(inlineText).join('\n\n')

/** Markdown bodies reaching the block kinds the wrapping corpus does not. */
const BODIES: readonly string[] = [
  '# Title\n\n> quoted *text* with `code`\n\n---\n\n```ts\nconst a: number = 1 // c\nfunction f(x) { return "s" + x }\n```',
  '| a | b |\n|---|:-:|\n| 1 | **2** |\n| ~~3~~ | [x](https://example.com) |\n\n<div>raw html</div>',
  '- [x] done\n- [ ] todo\n  1. nested\n  2. second\n\n![alt](https://example.com/i.png) and [[Some Page|alias]] and ![[Other#part]]',
  '```json\n{"a": [1, 2.5, null], "b": true}\n```\n\n```\nno language\n```\n\n[ref]: https://example.com',
  'Hello\\\nhard break, ***both***, a very long unbreakable-token-ThatKeepsGoingAndGoingAndGoingPastTheNodeWidth, 日本語の文章です。',
]

const canvasOf = (nodes: readonly SpatialNode[], edges: readonly CanvasEdge[]): SpatialCanvas => ({
  nodes: [...nodes],
  edges: [...edges],
})

// Fixed once when the generated canvases were drawn and committed as data: the
// freshness test reads the recorded canvases and draws nothing, so this is a
// fixture's provenance, never a property seed.
const GENERATED_SEED = 0x5ca1ab1e
const GENERATED_COUNT = 50

const OPTION_CYCLE: readonly RenderOptions[] = [
  { mode: 'light' },
  { mode: 'dark', style: 'document' },
  { mode: 'light', style: 'clean' },
]

export function renderInputs(): readonly RenderInput[] {
  const named: { id: string; canvas: SpatialCanvas }[] = [
    ...ROUTING_CORPUS.map((c) => ({ id: `routing/${c.name}`, canvas: canvasOf(c.nodes, c.edges) })),
    ...syntheticLayouts(12).map((c) => ({
      id: `routing/${c.name}`,
      canvas: canvasOf(c.nodes, c.edges),
    })),
    ...latticeLayouts(6).map((c) => ({
      id: `routing/lattice ${c.name}`,
      canvas: canvasOf(c.nodes, c.edges),
    })),
    ...stackedFrameLayouts(4).map((c) => ({
      id: `routing/frames ${c.name}`,
      canvas: canvasOf(c.nodes, c.edges),
    })),
    ...DRAWING_CORPUS.map((c) => ({ id: `drawing/${c.name}`, canvas: c.canvas })),
    ...TEXT_WRAPPING_CORPUS.flatMap((c) =>
      CORPUS_WIDTHS_PX.map((width) => ({
        id: `wrapping/${c.name}@${width}`,
        canvas: canvasOf(
          [textNode({ id: 'n', x: 0, y: 0, width, height: 240, text: markdownOf(c.root) })],
          [],
        ),
      })),
    ),
    ...BODIES.map((text, index) => ({
      id: `body/${index}`,
      canvas: canvasOf([textNode({ id: 'n', x: 0, y: 0, width: 360, height: 480, text })], []),
    })),
  ]
  const generated = fc
    .sample(spatialCanvasArbitrary, { seed: GENERATED_SEED, numRuns: GENERATED_COUNT })
    .map((canvas, index) => ({ id: `generated/${index}`, canvas }))
  return [...named, ...generated].map(({ id, canvas }, index) => ({
    id,
    canvas: viaJson(canvas),
    options: OPTION_CYCLE[index % OPTION_CYCLE.length] as RenderOptions,
  }))
}

const SVG_OPTION_CYCLE: readonly (SvgDocumentOptions | null)[] = [
  null,
  DETERMINISM_DOCUMENT_OPTIONS,
  { width: 320, height: 200, textFill: '#222222' },
  { viewBox: { x: -5, y: -5, w: 400, h: 300 }, legend: 'omit', rasterScale: 2 },
]

export function svgInputs(): readonly SvgInput[] {
  const goldens: { id: string; scene: Scene }[] = [
    { id: 'golden/every-kind', scene: buildEveryKindScene() },
    { id: 'golden/determinism', scene: buildDeterminismGoldenScene() },
    { id: 'golden/shape-appearance', scene: buildShapeAppearanceGoldenScene() },
    { id: 'pixel/jump-hop', scene: buildJumpHopScene() },
    { id: 'pixel/rounded-corners', scene: buildRoundedCornersScene() },
    { id: 'pixel/arrowheads', scene: buildArrowheadsScene() },
    { id: 'pixel/rounded-rect', scene: buildRoundedRectScene() },
    { id: 'pixel/node-outlines', scene: buildNodeOutlinesScene() },
    { id: 'pixel/icon-set', scene: buildIconSetScene() },
    { id: 'pixel/sketch-look', scene: buildSketchLookScene().scene },
    { id: 'pixel/neon-look', scene: buildNeonLookScene().scene },
  ]
  const fromLayout = renderInputs().map((input) => ({
    id: `layout/${input.id}`,
    scene: layoutRecorded(input.canvas, input.options),
  }))
  const perGolden = goldens.flatMap((g) =>
    SVG_OPTION_CYCLE.map((options, i) => ({ ...g, id: `${g.id}#${i}`, options })),
  )
  const perLayout = fromLayout.map((g, index) => ({
    ...g,
    options: SVG_OPTION_CYCLE[index % SVG_OPTION_CYCLE.length] as SvgDocumentOptions | null,
  }))
  return [...perGolden, ...perLayout].map(({ id, scene, options }) => ({
    id,
    scene: viaJson(scene),
    options: viaJson(options),
  }))
}

export const encodeLines = (records: readonly unknown[]): string =>
  `${records.map((record) => JSON.stringify(record)).join('\n')}\n`

export function decodeLines<T>(text: string): readonly T[] {
  return text
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as T)
}
