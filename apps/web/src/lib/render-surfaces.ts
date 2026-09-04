/**
 * Every place this app draws a picture of a document, and what each one does
 * about each document kind (ADR-0027 decision 6).
 *
 * This table exists because of a specific failure: markdown documents arrived
 * after the thumbnail paths did, the outline family absorbed them, and the SVG
 * family did not — nobody was forced to enumerate the surfaces the new kind
 * also had to reach. `kinds` is a `Record<DocumentKind, …>`, so adding a kind
 * to the model fails the type check here until every surface has an answer.
 * That is the direction that actually broke.
 *
 * The surface direction is weaker on purpose: a new component that renders
 * without asking the broker cannot be caught by a type, only by a reader with
 * this list in front of them. It is a list to review against, not a wall.
 *
 * `not covered:` and `not yet:` both take a reason. A bare exemption is the
 * omission with a word in front of it.
 */

import type { DocumentKind } from '@kamiazya/whiteboard-model'
import type { BrokeredPipeline } from './render-key.js'

export type RenderSurfaceId =
  | 'list-row-thumbnail'
  | 'list-preview-pane'
  | 'editor-preview-pane'
  | 'tree-row-icon'
  | 'favicon'
  | 'version-thumbnail'

/**
 * `svg` is layout plus serialisation, the expensive one. `outline` is block
 * geometry only — cheaper, and the only thing legible at 24px. `png-raster`
 * is the SVG drawn into a canvas and read back as PNG.
 */
export type RenderPipeline = BrokeredPipeline | 'png-raster'

type KindCoverage = 'covered' | `not covered: ${string}`
type BrokerUse = 'through' | `not yet: ${string}`

export interface RenderSurface {
  readonly pipeline: RenderPipeline
  readonly kinds: Readonly<Record<DocumentKind, KindCoverage>>
  readonly broker: BrokerUse
}

export const RENDER_SURFACES = {
  'list-row-thumbnail': {
    pipeline: 'svg',
    kinds: { spatial: 'covered', markdown: 'covered' },
    broker: 'through',
  },
  'list-preview-pane': {
    pipeline: 'svg',
    kinds: { spatial: 'covered', markdown: 'covered' },
    broker: 'through',
  },
  'editor-preview-pane': {
    pipeline: 'svg',
    kinds: {
      spatial:
        'not covered: a spatial document opens in the canvas editor, which has no preview pane',
      markdown: 'covered',
    },
    broker:
      'not yet: renders on the main thread per keystroke, so it wants a live seam rather than a memo',
  },
  'tree-row-icon': {
    pipeline: 'outline',
    kinds: { spatial: 'covered', markdown: 'covered' },
    broker: 'through',
  },
  favicon: {
    pipeline: 'outline',
    kinds: { spatial: 'covered', markdown: 'covered' },
    broker: 'through',
  },
  'version-thumbnail': {
    pipeline: 'png-raster',
    kinds: {
      spatial: 'covered',
      markdown:
        'not covered: the picture is exportScene(png), which draws the SPATIAL canvas, and a markdown document publishes none — so a daemon-kept markdown version stores a 1x1 blank and its row draws an empty box',
    },
    broker:
      'not yet: written once at save and read back as stored bytes, so there is no repeated render for an in-tab memo to join — and png-raster is deliberately outside brokeredPipelineSchema',
  },
} satisfies Record<RenderSurfaceId, RenderSurface>
