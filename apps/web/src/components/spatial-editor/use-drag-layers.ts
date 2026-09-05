// The drag/resize/connect render layers, extracted from SpatialEditor as one
// hook: everything here is pure derivation over the gesture and the committed
// scene (no React state of its own — one ref caches carried edge sides per
// gesture), producing the SVG layers the editor's JSX mounts. The split that
// matters is render-once-per-gesture (dragContentSvg, dragStatic) versus
// per-frame (dragPreview, liveEdges, liveNode), and each memo's comment says
// which side it is on and why.

import type {
  EdgeSides,
  KeyedSvgRender,
  MeasureText,
  Scene,
  TextMetrics,
} from '@kamiazya/whiteboard-canvas-render'
import {
  layoutSpatialEdges,
  renderSceneToSvg,
  sceneBounds,
} from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { useEffect, useMemo, useRef } from 'react'
import type { NodeBox } from '../../lib/spatial/geometry.js'
import type { Point } from '../../lib/spatial/viewport.js'
import type { ResolvedTheme } from '../../lib/theme.js'
import { useKeyedSvg } from '../../lib/use-keyed-svg.js'
import { computeDragPreview } from './drag-preview.js'
import { createEditorAppearance } from './editor-appearance.js'
import {
  type CarriedSideCache,
  canReuseCarriedSides,
  carriedByGesture,
  carriedSideCacheKey,
  commentExtensionFor,
  frozenSidesOf,
  ghostCommentObstacles,
  liveNodesFor,
} from './gesture-view.js'
import type { GestureState } from './gestures.js'
import { type RenderedCanvas, renderCanvasToSvg } from './scene-render.js'
import { renderedCanvasKeyed } from './scene-render-core.js'
import type { useFileSeamScene } from './use-file-seam-scene.js'
import { useGestureCaptured } from './use-gesture-captured.js'

export interface DragLayersInputs {
  gestureState: GestureState
  canvas: SpatialCanvas
  extraIds: ReadonlySet<string>
  /**
   * Closes over `lockEnabled`/`lockedNodeIds`; both ride along so the memo
   * dependency lists can name what the function actually reads.
   */
  isLocked: (nodeId: string) => boolean
  lockEnabled: boolean
  lockedNodeIds: ReadonlySet<string> | undefined
  resolvedMeasure: MeasureText
  theme: ResolvedTheme
  fileSeamOptions: ReturnType<typeof useFileSeamScene>['fileSeamOptions']
  /** The committed layout the worker (or sync path) delivered. */
  scene: Scene
  anchors: RenderedCanvas['anchors']
  /** The committed surface's keyed projection (mount-once patch container). */
  keyed: KeyedSvgRender
  /** Draw resolved comments in the drag layers too, matching the committed surface. */
  showResolved?: boolean
  boxes: readonly NodeBox[]
  selectableBoxes: readonly NodeBox[]
  livePoint: Point | null
}

export function useDragLayers({
  gestureState,
  canvas,
  extraIds,
  isLocked,
  lockEnabled,
  lockedNodeIds,
  resolvedMeasure,
  theme,
  fileSeamOptions,
  scene,
  anchors,
  keyed,
  showResolved,
  boxes,
  selectableBoxes,
  livePoint,
}: DragLayersInputs) {
  // The committed layout, FROZEN at gesture start. The worker's next
  // reply may land mid-gesture, and THREE things ride on it: the anchors
  // are the points bystander edges are pinned to, the scene is what
  // decides which edges are pin-eligible at all (frozenSidesOf) — a
  // swapped scene silently un-pins every bystander even with the anchors
  // held, which is the same re-fraction by another door — and the ghost's
  // comment obstacles below, which must keep answering the placement
  // question the way the committed scene answered it at the press.
  const committedPair = useMemo(() => ({ scene, anchors }), [scene, anchors])
  const gestureCommitted = useGestureCaptured(
    gestureState.kind === 'moving' ||
      gestureState.kind === 'resizing' ||
      gestureState.kind === 'connecting',
    committedPair,
  )

  /**
   * The dragged node's own content, rendered ONCE per drag (the reducer's
   * pointermove passthrough returns the same state reference, so this memo
   * holds for the whole gesture; a single-node render costs ~0.4ms).
   * Per-frame motion is then a pure CSS transform in DragPreviewLayer —
   * the full-canvas render stays untouched during the drag.
   */
  const dragContentSvg = useMemo(() => {
    if (gestureState.kind !== 'moving') return undefined
    const carried = carriedByGesture(canvas, gestureState, extraIds, isLocked)
    const nodes = canvas.nodes.filter((n) => carried.has(n.id))
    if (nodes.length === 0) return undefined
    // Same embed options as the committed scene: a ghost that drops an
    // expanded miniature back to a bare card mid-drag reads as data loss.
    // The carried nodes' own comments ride the ghost too (see
    // commentExtensionFor): they are drawn at the node's corner, and the
    // corner is what is moving.
    const ghostComments = commentExtensionFor(canvas, carried, true)
    // A riding comment's bubble is placed against what the COMMITTED scene
    // placed it against — the bystander nodes and the bubbles staying
    // behind — so at the press it sits exactly where it was drawn. Rendered
    // alone it would re-place in an empty canvas and jump quadrant.
    const ghostObstacles = ghostCommentObstacles(canvas, gestureCommitted.scene, carried)
    const rendered = renderCanvasToSvg(
      {
        nodes,
        edges: [],
        ...(ghostComments === undefined ? {} : { 'x-whiteboard': ghostComments }),
      },
      {
        measure: resolvedMeasure,
        theme,
        ...fileSeamOptions,
        showResolved,
        commentObstacles: ghostObstacles,
      },
    )
    return {
      svg: rendered.svg,
      originX: gestureState.startX - rendered.bounds.x,
      originY: gestureState.startY - rendered.bounds.y,
    }
    // isLocked closes over lockedNodeIds/lockEnabled, both listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    gestureState,
    canvas,
    extraIds,
    lockEnabled,
    lockedNodeIds,
    resolvedMeasure,
    theme,
    fileSeamOptions,
    gestureCommitted,
    showResolved,
  ])

  // Last optimized sides for the gesture's carried edges (see liveEdges).
  const carriedSideCacheRef = useRef<CarriedSideCache | null>(null)
  useEffect(() => {
    if (gestureState.kind !== 'moving' && gestureState.kind !== 'resizing') {
      carriedSideCacheRef.current = null
    }
  }, [gestureState.kind])

  /**
   * The scene WITHOUT everything the drag layers draw live: carried
   * nodes travel as the ghost, and EVERY edge re-routes per frame in
   * the live-edges layer — a bystander edge is excluded too, because
   * the moving node entering or leaving its path changes its route and
   * its line jumps, and a frozen copy would disagree with the drop
   * result. Rendered ONCE per drag (gestureState is reference-stable
   * across pointermoves), so per-frame cost stays with the small layers.
   * The returned `measure` memoizes per drag: edge labels measure on the
   * first live frame and every later frame re-places the cached metrics,
   * keeping pointermoves free of text measurement.
   * ponytail: the backdrop render here is ~21ms at 45 nodes (the anchor
   * pass, formerly ~7x that, now arrives with the committed scene); if
   * start jank reappears on much larger documents, the next rung is
   * reusing the committed scene graph for the backdrop instead of
   * re-rendering — drop the carried node runs, truncate at the first
   * edge, re-render the remainder (composeNode is per-node pure, so the
   * prefix equivalence holds while the backdrop stays edge-free).
   */
  const dragStatic = useMemo(() => {
    if (gestureState.kind !== 'moving' && gestureState.kind !== 'resizing') return undefined
    const carried = carriedByGesture(canvas, gestureState, extraIds, isLocked)
    const baseComments = commentExtensionFor(canvas, carried, false)
    const base: SpatialCanvas = {
      ...canvas,
      nodes: canvas.nodes.filter((n) => !carried.has(n.id)),
      edges: [],
      ...(baseComments === undefined ? {} : { 'x-whiteboard': baseComments }),
    }
    const rendered = renderCanvasToSvg(base, {
      measure: resolvedMeasure,
      theme,
      ...fileSeamOptions,
      showResolved,
    })
    const metricsCache = new Map<string, TextMetrics>()
    const measure: MeasureText = (text, font) => {
      const key = `${font.family}|${font.weight}|${font.style}|${font.sizePx}\u0000${text}`
      const hit = metricsCache.get(key)
      if (hit !== undefined) return hit
      const metrics = resolvedMeasure(text, font)
      metricsCache.set(key, metrics)
      return metrics
    }
    // The committed anchor state: liveEdges pins bystander edges to these
    // exact points so a carried edge joining their (node, side) group
    // cannot re-fraction them mid-drag. Taken from the committed scene's
    // OWN layout rather than re-run here — the anchor pass is the most
    // expensive step of a layout (measured: ~7x the backdrop render), and
    // these are also the anchors the pixels on screen were routed with,
    // which a fresh pass over a newer canvas is not.
    return {
      carried,
      keyed: renderedCanvasKeyed(rendered),
      bounds: rendered.bounds,
      measure,
      committedAnchors: gestureCommitted.anchors,
    }
    // isLocked closes over lockedNodeIds/lockEnabled, both listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    gestureState,
    canvas,
    gestureCommitted,
    extraIds,
    lockEnabled,
    lockedNodeIds,
    resolvedMeasure,
    theme,
    fileSeamOptions,
    showResolved,
  ])
  // The committed surface's mount-once container (see the editor's JSX):
  // during a gesture it patches to the drag backdrop, on drop back to the
  // committed render — both through the same keyed reconciliation.
  const canvasContentRef = useKeyedSvg(dragStatic?.keyed ?? keyed)

  /**
   * The in-flight preview geometry, derived per frame from the gesture's own
   * start snapshot plus the live pointer. Move/resize never read `canvas`
   * (see drag-preview.ts for why, and for the single-source
   * `resizeBoxByDelta` guarantee it documents); the connecting branch does —
   * it routes the prospective edge through the committed producer, a few
   * routeEdge calls per frame.
   */
  const dragPreview = useMemo(() => {
    // Existing edges keep their committed sides while a connect gesture
    // is in flight — same freeze the live drag overlay applies, so the
    // canvas around the pointer stays still and pointer frames skip the
    // crossing-optimization loop. The prospective edge itself derives
    // fresh each frame.
    const frozenEdgeSides = frozenSidesOf(gestureCommitted.scene)
    return computeDragPreview(gestureState, boxes, livePoint, {
      canvas,
      selectableBoxes,
      frozenEdgeSides,
    })
  }, [gestureState, livePoint, boxes, canvas, selectableBoxes, gestureCommitted])

  /**
   * EVERY edge, re-composed against the ghost's snapped live position and
   * rendered as an overlay — the per-frame half of live drag rendering.
   * Goes through canvas-render's `layoutSpatialEdges`, the same producer
   * the committed render uses, so routing detours around the moving node,
   * line jumps, and label placement all match the drop result exactly
   * (one producer per geometry). Per pointermove this is edge routing
   * plus a small serialization; text measurement is absorbed by
   * `dragStatic.measure`'s per-drag cache.
   */
  const liveEdges = useMemo(() => {
    if (
      (gestureState.kind !== 'moving' && gestureState.kind !== 'resizing') ||
      dragPreview === undefined ||
      dragPreview.kind !== 'box' ||
      dragStatic === undefined ||
      canvas.edges.length === 0
    ) {
      return undefined
    }
    const liveNodes = [...liveNodesFor(canvas, gestureState, dragPreview.box, dragStatic.carried)]
    // BYSTANDER sides stay frozen at their committed choices for the whole
    // gesture: re-optimizing them per frame would let unrelated routes
    // flip sides mid-drag. Edges attached to a CARRIED node re-optimize
    // through the same side optimizer the committed render uses (so the
    // drop cannot re-side an edge the preview never showed that way) —
    // but only once per CARRIED_RESIDE_STEP_PX of travel: the optimizer's
    // trial loop costs ~8-14ms and a side decision rarely changes within
    // a few pixels, so in-between frames reuse the cached sides as a full
    // override map, which skips the optimizer entirely.
    const carried = dragStatic.carried
    const carriedEdgeIds = new Set(
      canvas.edges
        .filter((edge) => carried.has(edge.fromNode) || carried.has(edge.toNode))
        .map((edge) => edge.id),
    )
    const frozenSides = new Map(
      [...frozenSidesOf(gestureCommitted.scene)]
        .filter(([id]) => !carriedEdgeIds.has(id))
        .map(([id, pair]) => {
          const pin = dragStatic.committedAnchors.get(id)
          return [
            id,
            {
              ...pair,
              from: pin?.from,
              fromLaneDepth: pin?.fromLaneDepth,
              to: pin?.to,
              toLaneDepth: pin?.toLaneDepth,
            },
          ] as const
        }),
    )
    const cacheKey = carriedSideCacheKey(carriedEdgeIds)
    const cache = carriedSideCacheRef.current
    const reuse = canReuseCarriedSides(cache, cacheKey, dragPreview.box.x, dragPreview.box.y)
    const overrides =
      reuse && cache !== null ? new Map([...frozenSides, ...cache.sides]) : frozenSides
    const nodes = layoutSpatialEdges(
      { ...canvas, nodes: liveNodes },
      {
        measure: dragStatic.measure,
        appearance: createEditorAppearance(theme),
        edgeSideOverrides: overrides,
      },
    )
    if (!reuse) {
      const sides = new Map<string, EdgeSides>()
      for (const node of nodes) {
        if (node.kind === 'edge' && carriedEdgeIds.has(node.id)) {
          sides.set(node.id, { fromSide: node.fromSide, toSide: node.toSide })
        }
      }
      carriedSideCacheRef.current = {
        key: cacheKey,
        anchorX: dragPreview.box.x,
        anchorY: dragPreview.box.y,
        sides,
      }
    }
    const liveBounds = sceneBounds({ nodes })
    return {
      svg: renderSceneToSvg(
        { nodes },
        { width: liveBounds.w, height: liveBounds.h, viewBox: liveBounds },
      ),
      bounds: liveBounds,
    }
  }, [gestureState, dragPreview, dragStatic, canvas, theme, gestureCommitted])

  /**
   * The resized node's own content, re-rendered at its PREVIEW size each
   * frame — a resize changes geometry, so the move ghost's render-once-
   * transform-per-frame trick cannot apply. Affordable because it is one
   * node (~0.4ms) and `dragStatic.measure` memoizes text metrics for the
   * gesture: the first frame warms the cache and later frames re-wrap
   * with zero new measure calls.
   *
   * File-node LOD (card vs inline embed) deliberately stays at its
   * COMMITTED decision for the whole gesture — the same freeze-then-
   * settle rule edge sides follow: a mid-gesture card/embed swap is
   * exactly the kind of flicker the freeze exists to prevent, and the
   * expansion hysteresis is stateful over the committed canvas. The
   * crossing of a size threshold takes effect on release.
   */
  const liveNode = useMemo(() => {
    if (
      gestureState.kind !== 'resizing' ||
      dragPreview === undefined ||
      dragPreview.kind !== 'box' ||
      dragStatic === undefined
    ) {
      return undefined
    }
    const resized = liveNodesFor(
      canvas,
      gestureState,
      dragPreview.box,
      new Set([gestureState.nodeId]),
    ).find((n) => n.id === gestureState.nodeId)
    if (resized === undefined) return undefined
    // The resized node's comments re-anchor to its LIVE corner each frame,
    // for the same reason the move ghost carries them.
    const liveComments = commentExtensionFor(canvas, dragStatic.carried, true)
    const rendered = renderCanvasToSvg(
      {
        nodes: [resized],
        edges: [],
        ...(liveComments === undefined ? {} : { 'x-whiteboard': liveComments }),
      },
      {
        measure: dragStatic.measure,
        theme,
        ...fileSeamOptions,
        showResolved,
      },
    )
    return { svg: rendered.svg, bounds: rendered.bounds }
  }, [gestureState, dragPreview, dragStatic, canvas, theme, fileSeamOptions])

  return { dragContentSvg, dragStatic, dragPreview, liveEdges, liveNode, canvasContentRef }
}
