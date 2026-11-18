import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { Scene } from '@kamiazya/whiteboard-scene'
import type { KeyedSvgRender } from '../../canvas-core.js'
import { layoutSpatialCanvasKeyedPicture, layoutSpatialCanvasPicture } from '../../core-picture.js'
import { layoutSceneDigest } from '../../layout/query-switch.js'
import type { SceneDigest } from '../../scene-digest-schema.js'
import { createSpatialTheme } from '../../theme/spatial-theme.js'
import { createFakeMeasure } from '../fake-measure.js'
import { testLayoutCore } from '../test-layout-core.js'
import { dumpScene } from './scene-dump.js'

/**
 * The recorded answers of the TypeScript renderer, which the Rust slices
 * replay byte for byte (ADR-0054 decision 11): `render.jsonl` for the layout
 * and its pictures, `svg.jsonl` for the SVG backend alone. Both are FROZEN: the
 * TypeScript composer and SVG backend that drew them are deleted, so a
 * re-recording would be the core judging itself. The measurer is
 * `createFakeMeasure()`, body parsing and highlighting are the package's own
 * defaults, and the appearance is the bundled theme in the recorded mode, so
 * nothing in an answer depends on a host.
 *
 * A record holds its inputs as well as its answers, so a crate that has no
 * corpus module and no generator can replay the files.
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
  readonly keyed: KeyedRecord
  /** The core's digest of the same layout, held to the digest the TypeScript wrote. */
  readonly digest: SceneDigest
}

/** The keyed projection less its whole-document text, which the record's `svg` already holds. */
type KeyedRecord = Pick<KeyedSvgRender, 'rootOpen' | 'rootAttrs' | 'groups'>

/** One row of `svg.jsonl` / `svg-edge-cases.jsonl`: a scene, the envelope it was drawn in, and the pictures. */
export interface SvgRecord {
  readonly id: string
  readonly scene: Scene
  /** The envelope options the SVG backend was given; `null` for none. */
  readonly options: Readonly<Record<string, unknown>> | null
  readonly svg: string
  readonly keyed: KeyedRecord
}

export type RenderInput = Pick<RenderRecord, 'id' | 'canvas' | 'options'>

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

export const encodeLines = (records: readonly unknown[]): string =>
  `${records.map((record) => JSON.stringify(record)).join('\n')}\n`

export function decodeLines<T>(text: string): readonly T[] {
  return text
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as T)
}
