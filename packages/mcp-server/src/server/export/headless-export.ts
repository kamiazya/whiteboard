// High-level headless export: take a canvas {workspaceId, path} and produce
// a PNG/SVG buffer using the browser-less renderer.
//
// Reads the document from the `StoreScope` it is handed, which is the one
// the keeper's routes serve. Mixing roots within one export was possible
// while the doc cache read the process's data dir and a separate file loader
// took an explicit one; tying both ends to the same scope closes that.

import { readFacets, readSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { readTagLibrary, type TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import { carriesATag, TAG_LIBRARY_PATH } from '@kamiazya/whiteboard-server-core'
import type { z } from 'zod'
import type { exportRequestSchema } from '../../shared/api-contracts/export.js'
import { documentExists, getDoc } from '../store/document-store.js'
import type { StoreScope } from '../store/store-scope.js'
import {
  type HeadlessExportResult,
  type HeadlessSvgExportResult,
  renderSpatialCanvasToPng,
  renderSpatialCanvasToSvg,
} from './headless-renderer.js'

// Derived from exportRequestSchema (zod-schema-discipline) instead of
// hand-written, so a wire-field rename/removal in the schema is caught at
// compile time here rather than silently drifting — this is the exact
// subset of exportRequestSchema that routes/export.ts forwards into the
// headless renderer; outputPath/overwrite are route-level concerns, not
// renderer options.
export type HeadlessCanvasExportOptions = Pick<
  z.infer<typeof exportRequestSchema>,
  'padding' | 'scale' | 'theme' | 'style'
>

// Reads the persisted doc and derives its spatial canvas. A doc holding only
// the retired Excalidraw `elements` list has no nodes and exports as an empty
// canvas, the same as every other surface shows it.
async function readCanvas(
  workspaceId: string,
  path: string,
  scope: StoreScope,
): Promise<SpatialCanvas> {
  return readSpatialCanvas(await getDoc(workspaceId, path, scope))
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
  scope: StoreScope,
): Promise<TagLibrary | undefined> {
  if (!carriesATag(canvas)) return undefined
  if (!(await documentExists(workspaceId, TAG_LIBRARY_PATH, scope))) return undefined
  return readTagLibrary(readFacets(await getDoc(workspaceId, TAG_LIBRARY_PATH, scope)))
}

interface HeadlessCanvasExportArgs {
  workspaceId: string
  path: string
  /** Which data directory the document is read from. */
  scope: StoreScope
  options?: HeadlessCanvasExportOptions
}

export async function exportCanvasHeadless(
  args: HeadlessCanvasExportArgs,
): Promise<HeadlessExportResult> {
  const canvas = await readCanvas(args.workspaceId, args.path, args.scope)
  const tagLibrary = await libraryFor(args.workspaceId, canvas, args.scope)
  return renderSpatialCanvasToPng(canvas, args.scope.layout.fontsDir, {
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
  const canvas = await readCanvas(args.workspaceId, args.path, args.scope)
  const tagLibrary = await libraryFor(args.workspaceId, canvas, args.scope)
  return renderSpatialCanvasToSvg(canvas, args.scope.layout.fontsDir, {
    padding: args.options?.padding,
    theme: args.options?.theme,
    style: args.options?.style,
    ...(tagLibrary === undefined ? {} : { tagLibrary }),
  })
}
