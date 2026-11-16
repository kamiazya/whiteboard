import type { MeasureText, ReferenceSeams, ReferenceWire } from '@kamiazya/whiteboard-canvas-render'
import {
  compareCodeUnit,
  nodeFile,
  nodeKind,
  type SpatialCanvas,
  type SpatialNode,
} from '@kamiazya/whiteboard-model'
import { useEffect, useMemo, useState } from 'react'
import { useMarkdownFragments } from '../../hooks/use-markdown-fragments.js'
import { createSpatialContentCache } from '../../lib/content-cache.js'
import type { FragmentLoaders } from '../../lib/fragment-requests.js'
import type { FileRefOption } from '../../lib/link-entries.js'
import type { ResolvedTheme } from '../../lib/theme.js'
import { type ReferenceChrome, useCanvasReferences } from './use-canvas-references.js'

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
  /** The host's reference wire, absent when the host resolves nothing. */
  readonly references: ReferenceWire | undefined
  readonly fileRefOptions: readonly FileRefOption[] | undefined
  readonly missingFileRef: ((file: string) => boolean) | undefined
  readonly resolvedMeasure: MeasureText
  readonly theme: ResolvedTheme
  /** Injection seam for tests; defaults to the real MathJax/mermaid engines. */
  readonly fragmentLoaders?: FragmentLoaders
}

/**
 * The file-reference seam, built once for every render path.
 *
 * ONE object for every scene-building call in the editor (committed scene,
 * drag ghost, drag-static backdrop, resize preview). Four hand-listed
 * copies is how a seam ends up wired into the committed render and missing
 * from the drag overlay, which reads as content vanishing mid-gesture.
 *
 * The host's labels and dangling references ride the wire as extras
 * (`useCanvasReferences`), so every thread — and the Rust core — builds the
 * same bundle from the same bytes and no function seam is composed here.
 */
export function useFileSeamScene({
  canvas,
  zoom,
  references,
  fileRefOptions,
  missingFileRef,
  resolvedMeasure,
  theme,
  fragmentLoaders,
}: FileSeamSceneInputs) {
  const chrome = useReferenceChrome(canvas, fileRefOptions, missingFileRef)
  const { wire: canvasWire, seams, revision } = useCanvasReferences(canvas, references, chrome)
  // The gate opens only for a host that resolves content: chrome alone rides
  // an empty wire and has nothing to expand into.
  const resolvesContent = references !== undefined
  const body = useBodySeams(resolvedMeasure, theme, seams, fragmentLoaders)
  const [expandedFileIds, setExpandedFileIds] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    if (!resolvesContent) return
    const candidates = canvas.nodes
      .filter((node) => nodeKind(node) === 'file')
      .filter((node) => {
        const w = node.width * zoom
        const h = node.height * zoom
        return expandedFileIds.has(node.id)
          ? w >= COLLAPSE_MIN_W && h >= COLLAPSE_MIN_H
          : w >= EXPAND_MIN_W && h >= EXPAND_MIN_H
      })
      .sort((a, b) => b.width * b.height - a.width * a.height || compareCodeUnit(a.id, b.id))
      .slice(0, EMBED_BUDGET)
    const next = new Set(candidates.map((node) => node.id))
    const unchanged =
      next.size === expandedFileIds.size && [...next].every((id) => expandedFileIds.has(id))
    if (!unchanged) setExpandedFileIds(next)
  }, [canvas, zoom, resolvesContent, expandedFileIds])
  const expandFileNode = useMemo(
    () => (resolvesContent ? (node: SpatialNode) => expandedFileIds.has(node.id) : undefined),
    [resolvesContent, expandedFileIds],
  )

  const fileSeamOptions = useMemo(
    () => ({ references: seams, expandFileNode, ...body.options }),
    [seams, expandFileNode, body.options],
  )
  // The gate's decision as data, for the worker: it reads the viewport,
  // which the worker does not have.
  const expandedFileIdList = useMemo(
    () => (expandFileNode === undefined ? undefined : [...expandedFileIds].sort()),
    [expandFileNode, expandedFileIds],
  )

  // The plain-data twins of `fileSeamOptions`, for `useWorkerScene`'s wire.
  const wire = {
    references: canvasWire,
    referencesRevision: revision,
    expandedFileIds: expandedFileIdList,
    ...body.wire,
  }
  return { fileSeamOptions, wire }
}

/**
 * Opaque file references (canvas ids minted in the browser) become readable
 * card labels through the host-supplied options list, and the ones the host
 * resolves as dangling on THIS canvas are marked — both as data, layered
 * over the wire.
 */
function useReferenceChrome(
  canvas: SpatialCanvas,
  fileRefOptions: readonly FileRefOption[] | undefined,
  missingFileRef: ((file: string) => boolean) | undefined,
): ReferenceChrome {
  const labels = useMemo(
    () =>
      fileRefOptions === undefined
        ? undefined
        : new Map(fileRefOptions.map((option) => [option.file, option.label])),
    [fileRefOptions],
  )
  const missing = useMemo(() => {
    if (missingFileRef === undefined) return undefined
    const refs = new Set<string>()
    for (const node of canvas.nodes) {
      const file = nodeFile(node)
      if (file !== undefined && missingFileRef(file)) refs.add(file)
    }
    return refs
  }, [canvas, missingFileRef])
  return useMemo(() => ({ labels, missing }), [labels, missing])
}

/**
 * What a text node's body is typeset with, and the body memo that is only
 * valid for it. One memo per measure+theme (the cache's validity contract),
 * dropped too when the references a body can embed or the fragments it is
 * typeset with change. It rides `fileSeamOptions`, so every synchronous
 * render path in the editor — the committed fallback, the drag backdrop, the
 * live resize node — shares it; it never crosses to the layout worker
 * (LayoutRequest carries plain data only), which keeps its own.
 */
function useBodySeams(
  measure: MeasureText,
  theme: ResolvedTheme,
  references: ReferenceSeams | undefined,
  fragmentLoaders: FragmentLoaders | undefined,
) {
  const { table, entries, onFragmentsAsked } = useMarkdownFragments(fragmentLoaders)
  const contentCache = useMemo(
    () => createSpatialContentCache(),
    [measure, theme, references, table],
  )
  const options = useMemo(() => ({ contentCache, ...table }), [contentCache, table])
  return { options, wire: { fragments: entries, onFragmentsAsked } }
}
