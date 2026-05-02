// High-level headless export: take a canvas {workspaceId, slug} and produce a
// PNG buffer using the browser-less renderer. Used by routes/export.ts as a
// fallback when no browser client is connected.
//
// Reads the data root from the daemon's configured DATA_DIR rather than
// taking it as a per-call argument. Mixing roots within one export was
// previously possible because the doc cache reads from DATA_DIR while the
// file loader took an explicit dataDir; tying both ends to the same
// canonical path closes that mismatch.

import { applyMinFontPx } from '../../shared/min-font-px.js'
import { embedExcalidrawScene } from '../../shared/png-embed-scene.js'
import { type ParentedElement, resolveParentedElements } from '../../shared/resolve-parented-elements.js'
import { getDoc } from '../store/doc-cache.js'
import { type HeadlessExportResult, renderSceneToPng } from './headless-renderer.js'
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

export async function exportCanvasHeadless(args: {
  workspaceId: string
  slug: string
  options?: HeadlessCanvasExportOptions
}): Promise<HeadlessExportResult> {
  const doc = await getDoc(args.workspaceId, args.slug)
  const rawElements = doc.getMovableList('elements').toJSON() as Array<Record<string, unknown>>
  // Resolve parent-follow custom fields into absolute x/y so rendering matches
  // the browser export, then keep all fields (Excalidraw ignores unknown ones).
  const elements = resolveParentedElements(
    rawElements as unknown as ParentedElement[],
  ) as unknown as Array<Record<string, unknown> & { id: string; type: string; isDeleted?: boolean }>
  const liveElements = elements.filter((e) => e.isDeleted !== true)
  const sizedElements = applyMinFontPx(liveElements, args.options?.minFontPx)
  // Pick the fileIds the canvas actually references so the file loader
  // does NOT touch attachments owned by other canvases in the same
  // workspace. Skipping deleted elements means a tombstoned image
  // does not pin the underlying blob into the export payload.
  const referencedFileIds = new Set<string>()
  for (const el of liveElements) {
    if (el.type !== 'image') continue
    const fileId = el.fileId
    if (typeof fileId === 'string' && fileId.length > 0) referencedFileIds.add(fileId)
  }
  const files = await loadCanvasFiles(args.workspaceId, referencedFileIds)

  const scene = {
    type: 'excalidraw' as const,
    version: 2,
    source: '@kamiazya/whiteboard',
    elements: sizedElements,
    appState: { viewBackgroundColor: '#ffffff' },
    files,
  }

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
