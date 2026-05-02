// High-level headless export: take a canvas {workspaceId, slug} and produce a
// PNG buffer using the browser-less renderer. Used by routes/export.ts as a
// fallback when no browser client is connected.

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
  dataDir: string
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
  const files = await loadCanvasFiles(args.dataDir, args.workspaceId)

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
