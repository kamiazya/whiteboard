/**
 * Where a conversation points, as a box on the canvas, and the viewport that
 * brings that box on screen.
 *
 * A whole-document conversation, and a text passage of a note, are about no
 * place on a canvas: answering `null` for them is what keeps "show me" from
 * moving the viewport to nowhere.
 */
import type { AnnotationAnchor, SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { Box } from './geometry.js'
import {
  type ContainerSize,
  type Point,
  panToShowTarget,
  type Viewport,
  type ViewportOcclusion,
  visibleSize,
} from './viewport.js'

/** The footprint given to a spot: a pin is drawn about this big. */
const SPOT_SIZE_PX = 28

function union(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null
  const minX = Math.min(...boxes.map((box) => box.x))
  const minY = Math.min(...boxes.map((box) => box.y))
  const maxX = Math.max(...boxes.map((box) => box.x + box.width))
  const maxY = Math.max(...boxes.map((box) => box.y + box.height))
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

function nodeBox(canvas: SpatialCanvas, id: string): Box | null {
  const node = canvas.nodes.find((entry) => entry.id === id)
  return node === undefined
    ? null
    : { x: node.x, y: node.y, width: node.width, height: node.height }
}

function pathBox(path: readonly Point[] | undefined): Box | null {
  if (path === undefined) return null
  return union(path.map((point) => ({ x: point.x, y: point.y, width: 0, height: 0 })))
}

export function anchorBox(
  anchor: AnnotationAnchor,
  canvas: SpatialCanvas,
  edgePathOf: (edgeId: string) => readonly Point[] | undefined,
): Box | null {
  if (anchor.kind === 'document') return null
  if (anchor.kind === 'text') {
    return anchor.nodeId === undefined ? null : nodeBox(canvas, anchor.nodeId)
  }
  if (anchor.nodeId !== undefined) return nodeBox(canvas, anchor.nodeId)
  if (anchor.edgeId !== undefined) return pathBox(edgePathOf(anchor.edgeId))
  if (anchor.nodeIds !== undefined) {
    return union(
      anchor.nodeIds.flatMap((id) => {
        const box = nodeBox(canvas, id)
        return box === null ? [] : [box]
      }),
    )
  }
  if (anchor.width !== undefined && anchor.height !== undefined) {
    return { x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height }
  }
  return {
    x: anchor.x - SPOT_SIZE_PX / 2,
    y: anchor.y - SPOT_SIZE_PX / 2,
    width: SPOT_SIZE_PX,
    height: SPOT_SIZE_PX,
  }
}

/**
 * The viewport that has `box` wholly on screen, or `undefined` when it
 * already is.
 *
 * Centred rather than nudged to the nearest edge: the reader asked to be
 * taken somewhere, and a box left hard against the border with its neighbours
 * out of frame reads as the jump having overshot nothing.
 */
export function viewportRevealing(
  box: Box,
  viewport: Viewport,
  containerSize: ContainerSize | null,
  occlusion: ViewportOcclusion = {},
): Viewport | undefined {
  if (containerSize === null) return undefined
  if (panToShowTarget(box, viewport, containerSize, occlusion) === undefined) return undefined
  const visible = visibleSize(containerSize, occlusion)
  const centreX = (occlusion.left ?? 0) + visible.width / 2
  const centreY = (occlusion.top ?? 0) + visible.height / 2
  return {
    ...viewport,
    x: box.x + box.width / 2 - centreX / viewport.zoom,
    y: box.y + box.height / 2 - centreY / viewport.zoom,
  }
}
