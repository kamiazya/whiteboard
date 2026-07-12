import { LoroMap } from 'loro-crdt'
import { z } from 'zod'
import { getLogger } from '../../log.js'
import type { DaemonClient } from '../daemon-client.js'
import { apiGetSnapshot, apiPostLoroUpdate } from './annotate.js'
import { parseCanvasId } from './canvas-id.js'
import { resolveAutoLayout, type LayoutEdge, type LayoutNode } from './resolve-auto-layout.js'
import { snapArrowEndpoints } from './snap-arrow.js'
import { resolveArrowLabelPosition } from './resolve-arrow-label-position.js'
import { resolveArrowRoute } from './resolve-arrow-route.js'

export const canvasAutoLayoutOutputSchema = z.object({
  nodeCount: z.number(),
  edgeCount: z.number(),
  movedCount: z.number(),
})

// MCP tool that treats rectangles and arrows on the current canvas as a directed
// graph, recomputes rectangle top-left positions with resolveAutoLayout, and
// writes the result back into the LoroDoc. Rectangles become nodes, arrows become
// edges, bound text follows its rectangle, and the incremental update is posted
// back to the server so connected browsers update immediately.

interface LoroElement {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  containerId?: string
  points?: [number, number][]
  text?: string
  originalText?: string
  isArrowLabel?: boolean
  isDeleted?: boolean
}

interface Point {
  x: number
  y: number
}

interface AutoLayoutPhaseTimings {
  snapshotLoad: number
  graphExtract: number
  layoutSolve: number
  arrowRebindAndLabelRelocate: number
  updatePost: number
}

// Check whether an arrow endpoint lies on a rectangle edge, with a small epsilon for float rounding.
const ENDPOINT_SNAP_EPS = 2
const LABEL_MATCH_RADIUS = 40
const LEGACY_LABEL_MAX_WIDTH = 150
const LEGACY_LABEL_MAX_HEIGHT = 40
const AUTO_LAYOUT_DEBUG_ENV = 'WHITEBOARD_MCP_DEBUG_AUTO_LAYOUT'

function pointOnRectEdge(point: { x: number; y: number }, rect: LoroElement): boolean {
  const onLeft =
    Math.abs(point.x - rect.x) <= ENDPOINT_SNAP_EPS &&
    point.y >= rect.y - ENDPOINT_SNAP_EPS &&
    point.y <= rect.y + rect.height + ENDPOINT_SNAP_EPS
  const onRight =
    Math.abs(point.x - (rect.x + rect.width)) <= ENDPOINT_SNAP_EPS &&
    point.y >= rect.y - ENDPOINT_SNAP_EPS &&
    point.y <= rect.y + rect.height + ENDPOINT_SNAP_EPS
  const onTop =
    Math.abs(point.y - rect.y) <= ENDPOINT_SNAP_EPS &&
    point.x >= rect.x - ENDPOINT_SNAP_EPS &&
    point.x <= rect.x + rect.width + ENDPOINT_SNAP_EPS
  const onBottom =
    Math.abs(point.y - (rect.y + rect.height)) <= ENDPOINT_SNAP_EPS &&
    point.x >= rect.x - ENDPOINT_SNAP_EPS &&
    point.x <= rect.x + rect.width + ENDPOINT_SNAP_EPS
  return onLeft || onRight || onTop || onBottom
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100
}

function shouldDebugAutoLayout(): boolean {
  return process.env[AUTO_LAYOUT_DEBUG_ENV] === '1'
}

function readTextValue(element: LoroElement): string {
  return element.text ?? element.originalText ?? ''
}

function distanceBetweenCenters(element: LoroElement, point: Point): number {
  const centerX = element.x + element.width / 2
  const centerY = element.y + element.height / 2
  return Math.hypot(centerX - point.x, centerY - point.y)
}

function pickNearestLabelCandidate(
  candidates: LoroElement[],
  point: Point,
): LoroElement | undefined {
  let best: { element: LoroElement; distance: number } | undefined
  for (const candidate of candidates) {
    const distance = distanceBetweenCenters(candidate, point)
    if (distance > LABEL_MATCH_RADIUS) continue
    if (!best || distance < best.distance) {
      best = { element: candidate, distance }
    }
  }
  return best?.element
}

function findArrowLabelCandidate(
  elements: LoroElement[],
  oldMidpoint: Point,
  usedLabelIds: Set<string>,
): LoroElement | undefined {
  const textCandidates = elements.filter(
    (el) => el.type === 'text' && el.isDeleted !== true && !usedLabelIds.has(el.id),
  )
  const strictCandidate = pickNearestLabelCandidate(
    textCandidates.filter((el) => el.isArrowLabel === true),
    oldMidpoint,
  )
  if (strictCandidate) return strictCandidate
  return pickNearestLabelCandidate(
    textCandidates.filter(
      (el) =>
        el.isArrowLabel !== true &&
        !el.containerId &&
        el.width <= LEGACY_LABEL_MAX_WIDTH &&
        el.height <= LEGACY_LABEL_MAX_HEIGHT,
    ),
    oldMidpoint,
  )
}

function isArrowObstacleCandidate(element: LoroElement): boolean {
  return (
    element.type === 'rectangle' ||
    element.type === 'text' ||
    element.type === 'ellipse' ||
    element.type === 'diamond'
  )
}

function buildArrowObstacles(
  elements: LoroElement[],
  options: {
    excludeElementIds?: string[]
    excludeContainerIds?: string[]
  } = {},
) {
  const excludeElementIds = new Set(options.excludeElementIds ?? [])
  const excludeContainerIds = new Set(options.excludeContainerIds ?? [])
  return elements
    .filter((el) => el.isDeleted !== true)
    .filter((el) => isArrowObstacleCandidate(el))
    .filter((el) => !excludeElementIds.has(el.id))
    .filter((el) => !(el.type === 'text' && el.isArrowLabel === true))
    .filter(
      (el) =>
        !(
          el.type === 'text' &&
          el.containerId !== undefined &&
          excludeContainerIds.has(el.containerId)
        ),
    )
    .map((el) => ({ x: el.x, y: el.y, width: el.width, height: el.height }))
}

export const canvasAutoLayoutInputShape = {
  canvasId: z.string(),
  direction: z.enum(['TB', 'LR']).optional(),
  layerGap: z.number().optional(),
  nodeGap: z.number().optional(),
  origin: z
    .object({
      x: z.number(),
      y: z.number(),
    })
    .optional(),
  pins: z
    .array(
      z.object({
        id: z.string(),
        rank: z.number().optional(),
        anchor: z.enum(['left', 'right', 'top', 'bottom', 'center']).optional(),
        column: z.number().optional(),
      }),
    )
    .optional(),
  groups: z
    .array(
      z.object({
        id: z.string(),
        elementIds: z.array(z.string()),
      }),
    )
    .optional(),
  groupGap: z.number().optional(),
} satisfies z.ZodRawShape

export function canvasAutoLayoutTool() {
  return {
    name: 'canvas_auto_layout',
    description:
      'Re-layout the canvas as a hierarchical directed graph. Rectangles become nodes, arrows become edges, and positions are recomputed so the diagram reads in the chosen direction (TB = top-to-bottom, default; LR = left-to-right). Bound labels (containerId) move with their rectangles. Elements that are not rectangles or that are disconnected land in layer 0.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        canvasId: { type: 'string', description: 'Canvas ID (workspaceId/slug)' },
        direction: {
          type: 'string',
          enum: ['TB', 'LR'],
          description: 'Layout direction. Default: TB (top-to-bottom).',
        },
        layerGap: {
          type: 'number',
          description: 'Gap between layers / ranks in pixels. Default: 80.',
        },
        nodeGap: {
          type: 'number',
          description: 'Gap between nodes within the same layer. Default: 40.',
        },
        origin: {
          type: 'object',
          description: 'Top-left of the laid-out diagram. Default: {x:40, y:40}.',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
          },
          required: ['x', 'y'],
        },
        pins: {
          type: 'array',
          description:
            'Pin specific element ids to fixed ranks/columns. rank/anchor control the layer axis (y for TB, x for LR); column controls the cross axis (horizontal slot within a rank). Use column for 2D layouts like "orders column vs payments column stacked under a common client". anchor "left"/"top" = rank 0, "right"/"bottom" = max rank, "center" = middle rank.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Element id (rectangle) to pin' },
              rank: { type: 'number', description: 'Explicit rank (0 = first layer)' },
              anchor: {
                type: 'string',
                enum: ['left', 'right', 'top', 'bottom', 'center'],
              },
              column: {
                type: 'number',
                description:
                  'Order within the same rank (0 = leftmost / topmost cross-axis slot). Nodes without column land after pinned nodes in original order.',
              },
            },
            required: ['id'],
          },
        },
        groups: {
          type: 'array',
          description:
            'Partition elements into subgraphs that lay out independently. Each group computes its own rank / column, and groups are placed side-by-side on the cross axis (x for TB, y for LR). Use for "two parallel service columns under a shared client" diagrams where a global BFS would collapse them into one column.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Group id (used for ordering and debug)' },
              elementIds: {
                type: 'array',
                items: { type: 'string' },
                description: 'Rect element ids that belong to this group.',
              },
            },
            required: ['id', 'elementIds'],
          },
        },
        groupGap: {
          type: 'number',
          description:
            'Gap between groups on the cross axis (default 80). Only used when groups is set.',
        },
      },
      required: ['canvasId'],
    },
    execute: async (
      args: {
        canvasId: string
        direction?: 'TB' | 'LR'
        layerGap?: number
        nodeGap?: number
        origin?: { x: number; y: number }
        pins?: Array<{
          id: string
          rank?: number
          anchor?: 'left' | 'right' | 'top' | 'bottom' | 'center'
          column?: number
        }>
        groups?: Array<{ id: string; elementIds: string[] }>
        groupGap?: number
      },
      client: DaemonClient,
    ): Promise<z.infer<typeof canvasAutoLayoutOutputSchema>> => {
      const debugEnabled = shouldDebugAutoLayout()
      const timings: AutoLayoutPhaseTimings = {
        snapshotLoad: 0,
        graphExtract: 0,
        layoutSolve: 0,
        arrowRebindAndLabelRelocate: 0,
        updatePost: 0,
      }
      let phaseStart = nowMs()
      const { workspaceId, slug } = parseCanvasId(args.canvasId)
      const doc = await apiGetSnapshot(client, workspaceId, slug)
      timings.snapshotLoad = roundMs(nowMs() - phaseStart)
      phaseStart = nowMs()
      const prevVV = doc.version()
      const list = doc.getMovableList('elements')
      const elements = list.toJSON() as LoroElement[]
      const liveElements = elements.filter((el) => el.isDeleted !== true)
      const rectangles = liveElements.filter((el) => el.type === 'rectangle')
      const arrows = liveElements.filter((el) => el.type === 'arrow')

      // Extract nodes.
      const nodes: LayoutNode[] = rectangles.map((r) => ({
        id: r.id,
        width: r.width,
        height: r.height,
      }))

      // Extract edges by mapping arrow endpoints to rectangles whose edges they touch.
      const edges: LayoutEdge[] = []
      for (const arrow of arrows) {
        const pts = arrow.points ?? []
        if (pts.length < 2) continue
        const [sdx, sdy] = pts[0]
        const [edx, edy] = pts[pts.length - 1]
        const startAbs = { x: arrow.x + sdx, y: arrow.y + sdy }
        const endAbs = { x: arrow.x + edx, y: arrow.y + edy }
        const source = rectangles.find((r) => pointOnRectEdge(startAbs, r))
        const target = rectangles.find((r) => pointOnRectEdge(endAbs, r))
        if (source && target && source.id !== target.id) {
          edges.push({ id: arrow.id, source: source.id, target: target.id })
        }
      }
      timings.graphExtract = roundMs(nowMs() - phaseStart)

      // Compute positions.
      phaseStart = nowMs()
      const { positions } = resolveAutoLayout({
        nodes,
        edges,
        config: {
          direction: args.direction ?? 'TB',
          layerGap: args.layerGap ?? 80,
          nodeGap: args.nodeGap ?? 40,
          origin: args.origin ?? { x: 40, y: 40 },
          pins: args.pins,
          groups: args.groups,
          groupGap: args.groupGap ?? 80,
        },
      })
      timings.layoutSolve = roundMs(nowMs() - phaseStart)

      // Index live LoroMap containers by id. toJSON() returns detached objects, so
      // use list.get(i) to keep access to the live LoroMap containers.
      const containerByIndex: LoroMap[] = []
      for (let i = 0; i < list.length; i++) {
        containerByIndex.push(list.get(i) as LoroMap)
      }
      const indexById = new Map<string, number>()
      elements.forEach((el, idx) => indexById.set(el.id, idx))

      // Apply new coordinates to each rectangle and move bound text by the same delta.
      let movedCount = 0
      for (const rect of rectangles) {
        const newPos = positions.get(rect.id)
        if (!newPos) continue
        const dx = newPos.x - rect.x
        const dy = newPos.y - rect.y
        if (dx === 0 && dy === 0) continue
        const rectIdx = indexById.get(rect.id)
        if (rectIdx === undefined) continue
        const rectMap = containerByIndex[rectIdx]
        rectMap.set('x', newPos.x)
        rectMap.set('y', newPos.y)
        movedCount++
        // Move bound text along with the rectangle.
        for (const el of liveElements) {
          if (el.type === 'text' && el.containerId === rect.id) {
            const textIdx = indexById.get(el.id)
            if (textIdx === undefined) continue
            const textMap = containerByIndex[textIdx]
            textMap.set('x', el.x + dx)
            textMap.set('y', el.y + dy)
          }
        }
      }

      // Rebind arrows after moving rectangles so each edge reconnects to the new rect positions.
      // Keep route/label obstacle handling aligned with annotate.ts, and recompute labels with
      // resolveArrowLabelPosition() instead of shifting by midpoint delta.
      const newRectById = new Map<string, { x: number; y: number; width: number; height: number }>()
      for (const rect of rectangles) {
        const newPos = positions.get(rect.id)
        newRectById.set(rect.id, {
          x: newPos?.x ?? rect.x,
          y: newPos?.y ?? rect.y,
          width: rect.width,
          height: rect.height,
        })
      }
      phaseStart = nowMs()
      const originalLiveElements = liveElements
      const usedLabelIds = new Set<string>()
      for (const edge of edges) {
        const arrowIdx = indexById.get(edge.id)
        if (arrowIdx === undefined) continue
        const arrowMap = containerByIndex[arrowIdx]
        const oldArrow = elements[arrowIdx]
        const oldPts = oldArrow.points ?? []
        if (oldPts.length < 2) continue
        const oldStart = { x: oldArrow.x + oldPts[0][0], y: oldArrow.y + oldPts[0][1] }
        const oldEnd = {
          x: oldArrow.x + oldPts[oldPts.length - 1][0],
          y: oldArrow.y + oldPts[oldPts.length - 1][1],
        }
        const oldMidX = (oldStart.x + oldEnd.x) / 2
        const oldMidY = (oldStart.y + oldEnd.y) / 2
        const srcRect = newRectById.get(edge.source)
        const tgtRect = newRectById.get(edge.target)
        if (!srcRect || !tgtRect) continue
        const srcCenter = { x: srcRect.x + srcRect.width / 2, y: srcRect.y + srcRect.height / 2 }
        const tgtCenter = { x: tgtRect.x + tgtRect.width / 2, y: tgtRect.y + tgtRect.height / 2 }
        const snapped = snapArrowEndpoints({
          start: srcCenter,
          end: tgtCenter,
          startBox: srcRect,
          endBox: tgtRect,
        })
        const currentElements = list.toJSON() as LoroElement[]
        const routeObstacles = buildArrowObstacles(currentElements, {
          excludeElementIds: [edge.source, edge.target],
          excludeContainerIds: [edge.source, edge.target],
        })
        const { points: newPoints } = resolveArrowRoute({
          start: snapped.start,
          end: snapped.end,
          obstacles: routeObstacles,
        })
        const xs = newPoints.map((p) => p[0])
        const ys = newPoints.map((p) => p[1])
        arrowMap.set('x', snapped.start.x)
        arrowMap.set('y', snapped.start.y)
        arrowMap.set('points', newPoints as unknown as Parameters<LoroMap['set']>[1])
        arrowMap.set('width', Math.max(...xs) - Math.min(...xs))
        arrowMap.set('height', Math.max(...ys) - Math.min(...ys))
        const label = findArrowLabelCandidate(
          originalLiveElements,
          { x: oldMidX, y: oldMidY },
          usedLabelIds,
        )
        if (!label) continue
        const labelIdx = indexById.get(label.id)
        if (labelIdx === undefined) continue
        const labelText = readTextValue(label)
        const labelPos = resolveArrowLabelPosition({
          start: snapped.start,
          end: snapped.end,
          text: labelText,
          obstacles: buildArrowObstacles(list.toJSON() as LoroElement[], {
            excludeElementIds: [label.id],
            excludeContainerIds: [edge.source, edge.target],
          }),
        })
        const labelMap = containerByIndex[labelIdx]
        labelMap.set('x', labelPos.target.x)
        labelMap.set('y', labelPos.target.y)
        usedLabelIds.add(label.id)
      }
      timings.arrowRebindAndLabelRelocate = roundMs(nowMs() - phaseStart)

      // POST the incremental update to Hono so connected browsers update too.
      phaseStart = nowMs()
      const update = doc.export({ mode: 'update', from: prevVV })
      if (update.byteLength > 0) {
        await apiPostLoroUpdate(client, workspaceId, slug, update)
      }
      timings.updatePost = roundMs(nowMs() - phaseStart)

      if (debugEnabled) {
        getLogger('canvas_auto_layout').debug(
          {
            canvasId: args.canvasId,
            nodeCount: nodes.length,
            edgeCount: edges.length,
            movedCount,
            timingsMs: timings,
          },
          'layout pass complete',
        )
      }

      return {
        nodeCount: nodes.length,
        edgeCount: edges.length,
        movedCount,
      }
    },
  }
}
