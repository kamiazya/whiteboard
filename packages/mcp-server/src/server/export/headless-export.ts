// High-level headless export: take a canvas {workspaceId, slug} and produce a
// PNG buffer using the browser-less renderer. Used by routes/export.ts as a
// fallback when no browser client is connected.
//
// Reads the data root from the daemon's configured data dir rather than
// taking it as a per-call argument. Mixing roots within one export was
// previously possible because the doc cache reads from the data dir while the
// file loader took an explicit dataDir; tying both ends to the same
// canonical path closes that mismatch.

import { applyMinFontPx } from '../../shared/min-font-px.js'
import { embedExcalidrawScene } from '../../shared/png-embed-scene.js'
import {
  type ParentedElement,
  resolveParentedElements,
} from '../../shared/resolve-parented-elements.js'
import { getDoc } from '../store/doc-cache.js'
import {
  type HeadlessExportResult,
  type HeadlessSvgExportResult,
  renderSceneToPng,
  renderSceneToSvg,
} from './headless-renderer.js'
import { loadCanvasFiles } from './load-canvas-files.js'

export interface HeadlessCanvasExportOptions {
  padding?: number
  scale?: number
  frameId?: string
  // Mirror the browser path: text elements with `fontSize < minFontPx`
  // are cloned with their fontSize bumped before rendering, so a label
  // that is readable in the canvas tab stays readable in a no-browser
  // export at the same scale.
  minFontPx?: number
  theme?: 'light' | 'dark'
}

// Shared by both format entry points below: reads the persisted doc, resolves
// parent-follow custom fields into absolute x/y, drops tombstones, and loads
// only the file attachments the live elements actually reference.
async function buildExportScene(
  workspaceId: string,
  slug: string,
  options?: HeadlessCanvasExportOptions,
) {
  const doc = await getDoc(workspaceId, slug)
  const rawElements = doc.getMovableList('elements').toJSON() as Array<Record<string, unknown>>
  const elements = resolveParentedElements(
    rawElements as unknown as ParentedElement[],
  ) as unknown as Array<Record<string, unknown> & { id: string; type: string; isDeleted?: boolean }>
  const liveElements = elements.filter((e) => e.isDeleted !== true)
  const sizedElements = applyMinFontPx(liveElements, options?.minFontPx)
  const referencedFileIds = new Set<string>()
  for (const el of liveElements) {
    if (el.type !== 'image') continue
    const fileId = el.fileId
    if (typeof fileId === 'string' && fileId.length > 0) referencedFileIds.add(fileId)
  }
  const files = await loadCanvasFiles(workspaceId, referencedFileIds)

  return {
    type: 'excalidraw' as const,
    version: 2,
    source: '@kamiazya/whiteboard',
    elements: sizedElements,
    appState: { viewBackgroundColor: '#ffffff' },
    files,
  }
}

export async function exportCanvasHeadless(args: {
  workspaceId: string
  slug: string
  options?: HeadlessCanvasExportOptions
}): Promise<HeadlessExportResult> {
  const scene = await buildExportScene(args.workspaceId, args.slug, args.options)

  const rendered = await renderSceneToPng(scene, {
    padding: args.options?.padding,
    scale: args.options?.scale,
    frameId: args.options?.frameId,
    theme: args.options?.theme,
  })

  // The browser export path uses Excalidraw's `exportToBlob({ embedScene: true })`
  // so a `.excalidraw.png` file dropped back onto the canvas restores the
  // scene. The headless path renders an SVG → PNG via resvg, which strips
  // any metadata, so we re-embed the scene JSON as a tEXt chunk to honor
  // the same `.excalidraw.png` contract.
  return {
    ...rendered,
    png: embedExcalidrawScene(rendered.png, scene),
  }
}

// SVG output is vector markup, not a raster asset, so there is nothing to
// re-embed a scene chunk into (unlike the PNG path above) — the `.svg` file
// is a plain rendering artifact, not a round-trippable `.excalidraw` file.
export async function exportCanvasHeadlessSvg(args: {
  workspaceId: string
  slug: string
  options?: HeadlessCanvasExportOptions
}): Promise<HeadlessSvgExportResult> {
  const scene = await buildExportScene(args.workspaceId, args.slug, args.options)
  return renderSceneToSvg(scene, {
    padding: args.options?.padding,
    frameId: args.options?.frameId,
    theme: args.options?.theme,
  })
}
