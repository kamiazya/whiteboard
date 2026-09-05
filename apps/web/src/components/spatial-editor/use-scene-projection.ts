// The post-scene derived memos, extracted from SpatialEditor: everything
// projected off the COMMITTED scene once useWorkerScene has produced it —
// the keyed patch surface, edge hit-test paths, comment chrome boxes, the
// selection's own boxes, and the minimap overview. Called immediately after
// useWorkerScene, since every input here is that hook's output (plus boxes,
// canvas, theme, selectedId, extraIds, all already available by then).

import type { BoundingBox, Scene } from '@kamiazya/whiteboard-canvas-render'
import {
  flattenDrawnEdgePath,
  SPATIAL_DARK_PALETTE,
  SPATIAL_LIGHT_PALETTE,
} from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { useMemo } from 'react'
import type { ResolvedTheme } from '../../hooks/useThemeMode.js'
import { type NodeBox, unionBox } from './geometry.js'
import { buildMinimapNodes } from './minimap.js'
import { renderedCanvasKeyed } from './scene-render-core.js'

export interface SceneProjectionInputs {
  readonly scene: Scene
  readonly bounds: BoundingBox
  readonly boxes: readonly NodeBox[]
  readonly canvas: SpatialCanvas
  readonly theme: ResolvedTheme
  readonly selectedId: string | null
  readonly extraIds: ReadonlySet<string>
}

export function useSceneProjection({
  scene,
  bounds,
  boxes,
  canvas,
  theme,
  selectedId,
  extraIds,
}: SceneProjectionInputs) {
  // The committed surface's keyed projection, derived from the scene the
  // worker (or sync path) delivered — ~3ms of stringify against the
  // 66-125ms layout, so the worker protocol stays plain-data. The patch
  // container below consumes it; the plain `svg` string is no longer
  // read here.
  const keyed = useMemo(() => renderedCanvasKeyed({ scene, bounds }), [scene, bounds])
  // Routed edge paths in canvas coordinates, for edge hit-testing and the
  // selection highlight. Edges have no area, so selection is a
  // distance-to-polyline test against a zoom-adjusted tolerance. The
  // hit/highlight path is the DRAWN line — rounded corners flattened and
  // line-jump hops arced over — via the same decomposition the SVG
  // backend serializes, so a tap and the highlight land on the ink.
  const edgePaths = useMemo(
    () =>
      scene.nodes.flatMap((node) =>
        node.kind === 'edge'
          ? [
              {
                id: node.id,
                path: flattenDrawnEdgePath(node.path, node.jumps, node.rounded === true),
              },
            ]
          : [],
      ),
    [scene],
  )
  // Comment chrome (pins and bubbles) from the committed scene, for
  // hit-testing: the shapes carry `${commentId}/pin` / `/bubble` ids and
  // the commentChrome marker (ADR-0025 decision 5), so the boxes a press
  // is tested against are exactly the boxes the renderer painted — one
  // producer for the geometry. Later entries draw on top, so hit-testing
  // walks them in reverse.
  const commentChromeBoxes = useMemo(
    () =>
      scene.nodes.flatMap((node) => {
        if (node.kind !== 'shape' || node.commentChrome !== true || node.id === undefined) return []
        const cut = node.id.lastIndexOf('/')
        if (cut <= 0) return []
        const part = node.id.slice(cut + 1)
        // A passage highlight (`passage-<n>`) is the thread's chrome too: a
        // press on the quoted words opens the conversation like a press on
        // its bubble.
        if (
          part !== 'pin' &&
          part !== 'bubble' &&
          part !== 'region' &&
          !part.startsWith('passage-')
        )
          return []
        return [{ commentId: node.id.slice(0, cut), part, bbox: node.bbox }]
      }),
    [scene],
  )
  /**
   * Every selected node with the box it currently occupies, primary first.
   *
   * The resize handles surround the UNION of these rather than the primary
   * alone: handles drawn around a group have to act on the group, or a
   * three-node selection offers one node's handles and resizes that node
   * while the other two watch.
   */
  const selectionMembers = useMemo(() => {
    if (selectedId === null) return []
    return [selectedId, ...extraIds].flatMap((id) => {
      const entry = boxes.find((candidate) => candidate.id === id)
      return entry === undefined ? [] : [{ id, box: entry.box }]
    })
  }, [selectedId, extraIds, boxes])
  const selectionBox = useMemo(
    () => unionBox(selectionMembers.map((member) => member.box)),
    [selectionMembers],
  )
  /**
   * Node boxes for the overview, with each authored colour resolved to the
   * accent the scene already uses for it. A preset key resolves through the
   * current mode's palette; a hex passes through; an unstyled node carries
   * no colour and the overview falls back to its muted default.
   */
  const minimapNodes = useMemo(() => {
    const palette = theme === 'dark' ? SPATIAL_DARK_PALETTE : SPATIAL_LIGHT_PALETTE
    return buildMinimapNodes(canvas.nodes, boxes, palette)
  }, [boxes, canvas, theme])

  return { keyed, edgePaths, commentChromeBoxes, selectionMembers, selectionBox, minimapNodes }
}
