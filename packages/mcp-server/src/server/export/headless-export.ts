// High-level headless export: take a canvas {workspaceId, path} and produce
// a PNG/SVG buffer using the browser-less renderer.
//
// Reads the data root from the daemon's configured data dir rather than
// taking it as a per-call argument. Mixing roots within one export was
// previously possible because the doc cache reads from the data dir while a
// separate file loader took an explicit dataDir; tying both ends to the
// same canonical path closes that mismatch.

import { readFacets, readSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { readTagLibrary, type TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import { carriesATag, TAG_LIBRARY_PATH } from '@kamiazya/whiteboard-server-core'
import type { LoroDoc } from 'loro-crdt'
import type { z } from 'zod'
import type { exportRequestSchema } from '../../shared/api-contracts/export.js'
import { getLogger } from '../log.js'
import { documentExists, getDoc } from '../store/document-store.js'
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
  'padding' | 'scale' | 'frameId' | 'minFontPx' | 'theme' | 'style'
>

// `doc.getMovableList(name)` CREATES the root container as a side effect of
// the call alone (even with no explicit write or commit) — it is not a
// read-only probe. `getShallowValue()` reflects only containers that
// already exist, so checking for the 'elements' key there — then reading
// the existing container's length via `getContainerById` — detects legacy
// data without ever mutating a normal (non-legacy) canvas's doc.
function hasLegacyElements(doc: LoroDoc): boolean {
  const containerId = doc.getShallowValue().elements
  if (typeof containerId !== 'string') return false
  const container = doc.getContainerById(containerId)
  return container !== undefined && 'length' in container && container.length > 0
}

// Test-only: exercises the non-mutating probe directly against a bare
// LoroDoc, isolated from document-store's own (separate, pre-existing)
// legacy-list-migration probe on the load path.
export const _hasLegacyElementsForTests = hasLegacyElements

// Shared by both format entry points below: reads the persisted doc and
// derives its spatial canvas. A doc whose spatial layer is empty but which
// still carries a legacy Excalidraw `elements` list is not an error — it is
// pre-migration data — so it degrades to a valid empty export with a
// named warning rather than rendering nothing with no explanation.
async function readCanvas(workspaceId: string, path: string): Promise<SpatialCanvas> {
  const doc = await getDoc(workspaceId, path)
  const canvas = readSpatialCanvas(doc)
  if (canvas.nodes.length === 0 && hasLegacyElements(doc)) {
    log.warning(
      { workspaceId, path },
      'canvas has no spatial nodes but carries legacy Excalidraw elements; exporting an empty canvas',
    )
  }
  return canvas
}

/**
 * The workspace's tag library, for a board that can read one (ADR-0040
 * decision 5): what the document at `tags` declares, or nothing. Probes
 * existence FIRST — `getDoc` answers a missing path with an empty document
 * it then keeps, so asking without the probe would mint a `tags` document
 * on every export of every workspace. Asked only for a tagged board, so an
 * untagged one costs neither the probe nor the read.
 */
async function libraryFor(
  workspaceId: string,
  canvas: SpatialCanvas,
): Promise<TagLibrary | undefined> {
  if (!carriesATag(canvas)) return undefined
  if (!(await documentExists(workspaceId, TAG_LIBRARY_PATH))) return undefined
  return readTagLibrary(readFacets(await getDoc(workspaceId, TAG_LIBRARY_PATH)))
}

interface HeadlessCanvasExportArgs {
  workspaceId: string
  path: string
  options?: HeadlessCanvasExportOptions
}

export async function exportCanvasHeadless(
  args: HeadlessCanvasExportArgs,
): Promise<HeadlessExportResult> {
  const canvas = await readCanvas(args.workspaceId, args.path)
  const tagLibrary = await libraryFor(args.workspaceId, canvas)
  return renderSpatialCanvasToPng(canvas, {
    padding: args.options?.padding,
    scale: args.options?.scale,
    theme: args.options?.theme,
    style: args.options?.style,
    ...(tagLibrary === undefined ? {} : { tagLibrary }),
  })
}

export async function exportCanvasHeadlessSvg(
  args: HeadlessCanvasExportArgs,
): Promise<HeadlessSvgExportResult> {
  const canvas = await readCanvas(args.workspaceId, args.path)
  const tagLibrary = await libraryFor(args.workspaceId, canvas)
  return renderSpatialCanvasToSvg(canvas, {
    padding: args.options?.padding,
    theme: args.options?.theme,
    style: args.options?.style,
    ...(tagLibrary === undefined ? {} : { tagLibrary }),
  })
}
