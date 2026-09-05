import {
  type MeasureText,
  overlayReferences,
  type ReferenceSeams,
} from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { useEffect, useMemo, useState } from 'react'
import { createSpatialContentCache } from '../../lib/content-cache.js'
import type { FileRefOption } from '../../lib/link-entries.js'
import type { ResolvedTheme } from '../../lib/theme.js'

/**
 * The LOD gate (embed spec v2, user decision 2026-08-08): a file node
 * expands into an inline miniature only while its ON-SCREEN box is
 * large enough to be legible. Hysteresis (expand at >=200x140, collapse
 * below 160x110 CSS px) keeps pinch-zoom from flickering at the
 * boundary, and a budget caps simultaneous miniatures at the largest
 * candidates (deterministic tie-break by node id). The set is state so
 * layout re-runs only when membership actually changes — never per
 * zoom frame.
 */
// Exported because LinkEmbedLayer's shouldOffer mirrors the canvas-embed
// thresholds: a link iframe is offered at exactly the size a file miniature
// would expand, so the two LOD gates stay one decision.
export const EXPAND_MIN_W = 200
export const EXPAND_MIN_H = 140
const COLLAPSE_MIN_W = 160
const COLLAPSE_MIN_H = 110
const EMBED_BUDGET = 8

export interface FileSeamSceneInputs {
  readonly canvas: SpatialCanvas
  /** The live viewport zoom — the LOD gate compares on-screen pixel size. */
  readonly zoom: number
  /** The host's reference seams, absent when the host resolves nothing. */
  readonly references: ReferenceSeams | undefined
  readonly fileRefOptions: readonly FileRefOption[] | undefined
  readonly missingFileRef: ((file: string) => boolean) | undefined
  readonly resolvedMeasure: MeasureText
  readonly theme: ResolvedTheme
}

/**
 * The file-reference seam, built once for every render path.
 *
 * ONE object for every scene-building call in the editor (committed scene,
 * drag ghost, drag-static backdrop, resize preview). Four hand-listed
 * copies is how a seam ends up wired into the committed render and missing
 * from the drag overlay, which reads as content vanishing mid-gesture.
 *
 * `resolveReferenceContent` rides along UNCOMPOSED so the worker gate can
 * still tell content (which cannot be serialized) from label/missing
 * (which already cross as data). `missingFileRefs` is the plain-data twin
 * of the seam's `missing` field for the same reason: the worker path
 * cannot take a function.
 */
export function useFileSeamScene({
  canvas,
  zoom,
  references,
  fileRefOptions,
  missingFileRef,
  resolvedMeasure,
  theme,
}: FileSeamSceneInputs) {
  const resolveReference = references?.resolveReference
  const [expandedFileIds, setExpandedFileIds] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    if (resolveReference === undefined) return
    const candidates = canvas.nodes
      .filter((node): node is Extract<SpatialNode, { type: 'file' }> => node.type === 'file')
      .filter((node) => {
        const w = node.width * zoom
        const h = node.height * zoom
        return expandedFileIds.has(node.id)
          ? w >= COLLAPSE_MIN_W && h >= COLLAPSE_MIN_H
          : w >= EXPAND_MIN_W && h >= EXPAND_MIN_H
      })
      .sort((a, b) => b.width * b.height - a.width * a.height || a.id.localeCompare(b.id))
      .slice(0, EMBED_BUDGET)
    const next = new Set(candidates.map((node) => node.id))
    const unchanged =
      next.size === expandedFileIds.size && [...next].every((id) => expandedFileIds.has(id))
    if (!unchanged) setExpandedFileIds(next)
  }, [canvas, zoom, resolveReference, expandedFileIds])
  const expandFileNode = useMemo(
    () =>
      resolveReference === undefined
        ? undefined
        : (node: Extract<SpatialNode, { type: 'file' }>) => expandedFileIds.has(node.id),
    [resolveReference, expandedFileIds],
  )

  // Opaque file references (canvas ids minted in the browser) become readable
  // card labels through the host-supplied options list.
  const fileRefLabelMap = useMemo(
    () =>
      fileRefOptions === undefined
        ? undefined
        : new Map(fileRefOptions.map((option) => [option.file, option.label])),
    [fileRefOptions],
  )
  const missingRefSet = useMemo(() => {
    if (missingFileRef === undefined) return undefined
    const refs = new Set<string>()
    for (const node of canvas.nodes) {
      if (node.type === 'file' && missingFileRef(node.file)) refs.add(node.file)
    }
    return refs.size === 0 ? undefined : refs
  }, [canvas, missingFileRef])
  const missingFileRefs = useMemo(
    () => (missingRefSet === undefined ? undefined : [...missingRefSet]),
    [missingRefSet],
  )
  // One text-node body memo per measure+theme (the cache's validity
  // contract); rides fileSeamOptions so every synchronous render path in
  // the editor — the committed fallback, the drag backdrop, the live
  // resize node — shares it. It never crosses to the layout worker
  // (LayoutRequest carries plain data only); the worker keeps its own.
  const contentCache = useMemo(
    () => createSpatialContentCache(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- theme, measure
    // and the references a text node's body can embed invalidate cached
    // layout; nothing else does.
    [resolvedMeasure, theme, references],
  )
  const fileSeamOptions = useMemo(
    () => ({
      references,
      resolveReference: overlayReferences({
        content: resolveReference,
        labels: fileRefLabelMap,
        missing: missingRefSet,
      }),
      expandFileNode,
      contentCache,
    }),
    [references, resolveReference, fileRefLabelMap, missingRefSet, expandFileNode, contentCache],
  )
  // The gate's decision as data, for the worker: it reads the viewport,
  // which the worker does not have.
  const expandedFileIdList = useMemo(
    () => (expandFileNode === undefined ? undefined : [...expandedFileIds].sort()),
    [expandFileNode, expandedFileIds],
  )

  return { fileSeamOptions, missingFileRefs, expandedFileIds: expandedFileIdList }
}
