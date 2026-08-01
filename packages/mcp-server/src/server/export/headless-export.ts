// High-level headless export: take a canvas {workspaceId, slug} and produce
// a PNG/SVG buffer using the browser-less renderer.
//
// Reads the data root from the daemon's configured data dir rather than
// taking it as a per-call argument. Mixing roots within one export was
// previously possible because the doc cache reads from the data dir while a
// separate file loader took an explicit dataDir; tying both ends to the
// same canonical path closes that mismatch.

import { readSpatialCanvas } from '@kamiazya/whiteboard-canvas-workspace'
import type { z } from 'zod'
import type { exportRequestSchema } from '../../shared/api-contracts/export.js'
import { getLogger } from '../log.js'
import { getDoc } from '../store/doc-cache.js'
import {
  type HeadlessExportResult,
  type HeadlessSvgExportResult,
  renderSpatialCanvasToPng,
  renderSpatialCanvasToSvg,
} from './headless-renderer.js'

const log = getLogger('headless-export')

// Derived from exportRequestSchema (zod-schema-discipline) instead of
// hand-written, so a wire-field rename/removal in the schema is caught at
// compile time here rather than silently drifting — this is the exact
// subset of exportRequestSchema that routes/export.ts forwards into the
// headless renderer; outputPath/overwrite are route-level concerns, not
// renderer options. `frameId`/`minFontPx` are accepted for wire
// compatibility (older browser-export callers still send them) but are
// Excalidraw-era concepts with no SpatialCanvas equivalent, so the renderer
// deliberately ignores both.
export type HeadlessCanvasExportOptions = Pick<
  z.infer<typeof exportRequestSchema>,
  'padding' | 'scale' | 'frameId' | 'minFontPx' | 'theme'
>

// Shared by both format entry points below: reads the persisted doc and
// derives its spatial canvas. A doc whose spatial layer is empty but which
// still carries a legacy Excalidraw `elements` list is not an error — it is
// pre-migration data — so it degrades to a valid empty export with a
// named warning rather than rendering nothing with no explanation.
async function readCanvas(workspaceId: string, slug: string) {
  const doc = await getDoc(workspaceId, slug)
  const canvas = readSpatialCanvas(doc)
  if (canvas.nodes.length === 0 && doc.getMovableList('elements').length > 0) {
    log.warning(
      { workspaceId, slug },
      'canvas has no spatial nodes but carries legacy Excalidraw elements; exporting an empty canvas',
    )
  }
  return canvas
}

export async function exportCanvasHeadless(args: {
  workspaceId: string
  slug: string
  options?: HeadlessCanvasExportOptions
}): Promise<HeadlessExportResult> {
  const canvas = await readCanvas(args.workspaceId, args.slug)
  return renderSpatialCanvasToPng(canvas, {
    padding: args.options?.padding,
    scale: args.options?.scale,
    theme: args.options?.theme,
  })
}

export async function exportCanvasHeadlessSvg(args: {
  workspaceId: string
  slug: string
  options?: HeadlessCanvasExportOptions
}): Promise<HeadlessSvgExportResult> {
  const canvas = await readCanvas(args.workspaceId, args.slug)
  return renderSpatialCanvasToSvg(canvas, {
    padding: args.options?.padding,
    theme: args.options?.theme,
  })
}
