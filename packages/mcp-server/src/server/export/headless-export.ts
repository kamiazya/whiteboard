// High-level headless export: take a canvas {workspaceId, path} and produce
// a PNG/SVG buffer using the browser-less renderer.
//
// Reads the document from the `StoreScope` it is handed, which is the one
// the keeper's routes serve. Mixing roots within one export was possible
// while the doc cache read the process's data dir and a separate file loader
// took an explicit one; tying both ends to the same scope closes that.

import type { LayoutCore } from '@kamiazya/whiteboard-canvas-render'
import type { RecordSession } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { readTagLibrary, type TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import { drawsATag, readRestoringRefusal, TAG_LIBRARY_PATH } from '@kamiazya/whiteboard-server-core'
import type { z } from 'zod'
import type { exportRequestSchema } from '../../shared/api-contracts/export.js'
import { documentExists } from '../store/document-store.js'
import type { StoreScope } from '../store/store-scope.js'
import { withStoredWorkspaceRecord } from '../store/workspace-doc-cache.js'
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

// The engine answers in the shapes the loro-adapter readers return; this
// module asserts the type and holds no schema of its own for it.
const asserted = <T>() => ({ parse: (value: unknown) => value as T })

/**
 * What the record reads for the document at `path`, or `undefined` when it
 * holds none: a read of the record's own node, so no copy of the document is
 * cut for it.
 */
async function readAtPath<T>(
  workspaceId: string,
  path: string,
  scope: StoreScope,
  query: 'spatialCanvas' | 'facets',
  shape: { parse(value: unknown): T },
): Promise<T | undefined> {
  return withStoredWorkspaceRecord(workspaceId, scope, async (record) => {
    if (record === null) return undefined
    const documentId = await documentIdAt(record, path)
    if (documentId === undefined) return undefined
    return readRestoringRefusal(record, { query, args: { documentId } }, shape)
  })
}

async function documentIdAt(record: RecordSession, path: string): Promise<string | undefined> {
  const entry = await record.read(
    { query: 'workspaceDocumentEntry', args: { path } },
    asserted<{ documentId: string } | null>(),
  )
  return entry?.documentId
}

// Reads the persisted doc and derives its spatial canvas. A doc holding
// entries in the retired Excalidraw `elements` list is refused
// (RetiredStoredShapeError) rather than exported as an empty canvas. A path
// the record does not hold answers an empty canvas, as an empty document does.
async function readCanvas(
  workspaceId: string,
  path: string,
  scope: StoreScope,
): Promise<SpatialCanvas> {
  const read = await readAtPath(
    workspaceId,
    path,
    scope,
    'spatialCanvas',
    asserted<{ canvas: SpatialCanvas }>(),
  )
  return read?.canvas ?? { nodes: [], edges: [] }
}

/**
 * The workspace's tag library, for a board that can read one (ADR-0040
 * decision 5): what the document at `tags` declares, or nothing. Probes
 * existence FIRST: a missing path answers an empty document, which would read
 * as a library declaring nothing rather than as no library.
 * Asked only when `drawsATag` says so, so an untagged board costs neither the
 * probe nor the read. This export draws the board alone and resolves no
 * reference, so the board is the whole of what it draws.
 */
async function libraryFor(
  workspaceId: string,
  canvas: SpatialCanvas,
  scope: StoreScope,
): Promise<TagLibrary | undefined> {
  if (!drawsATag([canvas])) return undefined
  if (!(await documentExists(workspaceId, TAG_LIBRARY_PATH, scope))) return undefined
  const facets = await readAtPath(
    workspaceId,
    TAG_LIBRARY_PATH,
    scope,
    'facets',
    asserted<Parameters<typeof readTagLibrary>[0]>(),
  )
  return readTagLibrary(facets ?? {})
}

interface HeadlessCanvasExportArgs {
  workspaceId: string
  path: string
  /** Which data directory the document is read from. */
  scope: StoreScope
  options?: HeadlessCanvasExportOptions
  /**
   * The composition root's `ServerDeps.layoutCore`, so the file export lays
   * out through the same loaded core as `wb_scene_render`.
   */
  layoutCore: () => Promise<LayoutCore>
}

async function coreOf(args: HeadlessCanvasExportArgs): Promise<{ core: LayoutCore }> {
  return { core: await args.layoutCore() }
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
    ...(await coreOf(args)),
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
    ...(await coreOf(args)),
  })
}
