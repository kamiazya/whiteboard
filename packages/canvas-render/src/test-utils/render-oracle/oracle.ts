import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { Scene } from '@kamiazya/whiteboard-scene'
import { layoutSpatialCanvasKeyedPicture, layoutSpatialCanvasPicture } from '../../core-picture.js'
import { layoutSceneDigest } from '../../layout/query-switch.js'
import type { SceneDigest } from '../../scene-digest-schema.js'
import { renderSceneToSvg, type SvgDocumentOptions } from '../../svg/backend.js'
import { renderSceneToKeyedSvg } from '../../svg/keyed.js'
import { createSpatialTheme } from '../../theme/spatial-theme.js'
import { createFakeMeasure } from '../fake-measure.js'
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
import { testLayoutCore } from '../test-layout-core.js'
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
 * neither. Both are frozen: the canvases `render.jsonl` lays out and the
 * scenes `svg.jsonl`'s `layout/` records draw are recorded inputs, not rebuilt.
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
  /** The core's digest of the same layout, held to the digest the TypeScript wrote. */
  readonly digest: SceneDigest
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

function layoutOptionsRecorded(options: RenderOptions) {
  return {
    core: testLayoutCore(),
    measure: createFakeMeasure(),
    appearance: createSpatialTheme({ mode: options.mode }),
    ...(options.style === undefined ? {} : { style: options.style }),
  }
}

/**
 * What the core answers for a recorded canvas: the scene, and the picture
 * and keyed groups it drew of it in the bodyless root an empty ask names.
 */
export function renderAnswer(input: RenderInput): RenderRecord {
  const options = layoutOptionsRecorded(input.options)
  const { scene, svg } = layoutSpatialCanvasPicture(input.canvas, options, {})
  const { rootOpen, rootAttrs, groups } = layoutSpatialCanvasKeyedPicture(
    input.canvas,
    options,
    {},
  ).keyed
  return {
    id: input.id,
    canvas: input.canvas,
    options: input.options,
    scene: dumpScene(scene),
    svg,
    keyed: { rootOpen, rootAttrs, groups },
    digest: layoutSceneDigest(input.canvas, options),
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

const SVG_OPTION_CYCLE: readonly (SvgDocumentOptions | null)[] = [
  null,
  DETERMINISM_DOCUMENT_OPTIONS,
  { width: 320, height: 200, textFill: '#222222' },
  { viewBox: { x: -5, y: -5, w: 400, h: 300 }, legend: 'omit', rasterScale: 2 },
]

/** The padding the pixel goldens are mounted in. */
const PIXEL_MOUNT_PADDING_PX = 8

/**
 * The inputs of `svg.jsonl`'s hand-built records: each golden in every
 * envelope of the cycle, and the pixel goldens as the browser mounts them.
 * The recording's `layout/` records are frozen inputs and are not rebuilt.
 */
export function svgGoldenInputs(): readonly SvgInput[] {
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
  const perGolden = goldens.flatMap((g) =>
    SVG_OPTION_CYCLE.map((options, i) => ({ ...g, id: `${g.id}#${i}`, options })),
  )
  // The pixel goldens as the browser test mounts them, so the picture it
  // screenshots is a recorded string the core is held to.
  const sketch = buildSketchLookScene()
  const neon = buildNeonLookScene()
  const pixelMounts = [
    ...goldens.filter((g) => g.id.startsWith('pixel/') && !g.id.endsWith('-look')),
    { id: 'pixel/sketch-look', scene: sketch.scene, background: sketch.background },
    { id: 'pixel/neon-look', scene: neon.scene, background: neon.background },
  ].map((g) => ({
    id: `pixel-mount/${g.id.slice('pixel/'.length)}`,
    scene: g.scene,
    options: {
      padding: PIXEL_MOUNT_PADDING_PX,
      background: 'background' in g ? g.background : '#ffffff',
    },
  }))
  return [...perGolden, ...pixelMounts].map(({ id, scene, options }) => ({
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
