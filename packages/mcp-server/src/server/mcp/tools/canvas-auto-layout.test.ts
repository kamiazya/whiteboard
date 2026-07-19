import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoroDoc, LoroMap } from 'loro-crdt'

const { annotateTool } = await import('./annotate.js')
const { annotateBatchTool } = await import('./annotate-batch.js')
const { canvasAutoLayoutTool } = await import('./canvas-auto-layout.js')
const { assignToGroupTool, deleteGroupTool } = await import('./element-ops-tools.js')
const { createFrameTool, updateFrameMembersTool } = await import('./frame-embed.js')

const client = {
  port: 3099,
  baseUrl: 'http://localhost:3099',
  request: (path: string, init?: RequestInit) =>
    globalThis.fetch(new URL(path, 'http://localhost:3099'), init),
  touch: async () => undefined,
}

interface CanvasElement {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  points?: [number, number][]
  text?: string
  originalText?: string
  containerId?: string | null
  frameId?: string | null
  isArrowLabel?: boolean
  isDeleted?: boolean
}

interface HarnessState {
  canvases: Map<string, LoroDoc>
}

interface Point {
  x: number
  y: number
}

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

function canvasKey(canvasId: string): string {
  return canvasId
}

function cloneDoc(doc: LoroDoc): LoroDoc {
  return LoroDoc.fromSnapshot(doc.export({ mode: 'snapshot' }))
}

function ensureCanvas(state: HarnessState, canvasId: string): LoroDoc {
  const key = canvasKey(canvasId)
  let doc = state.canvases.get(key)
  if (!doc) {
    doc = new LoroDoc()
    state.canvases.set(key, doc)
  }
  return doc
}

function decodeBinaryBody(body: RequestInit['body']): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return Promise.resolve(body)
  if (body instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(body))
  return new Response(body as BodyInit).arrayBuffer().then((buffer) => new Uint8Array(buffer))
}

function installFetchMock(state: HarnessState) {
  const originalFetch = globalThis.fetch
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input.toString())
    const parts = url.pathname.split('/').filter(Boolean)
    const method = init?.method ?? 'GET'

    if (parts[0] === 'api' && parts[1] === 'canvas' && parts[4] === 'exists') {
      // This harness treats every referenced canvasId as already created
      // (ensureCanvas lazily seeds it), so the existence check always passes.
      return new Response(JSON.stringify({ exists: true }), { status: 200 })
    }

    if (parts[0] === 'api' && parts[1] === 'canvas' && parts[4] === 'snapshot') {
      const canvasId = `${parts[2]}/${decodeURIComponent(parts[3])}`
      const doc = ensureCanvas(state, canvasId)
      return new Response(doc.export({ mode: 'snapshot' }), { status: 200 })
    }

    if (
      parts[0] === 'api' &&
      ['sessions', 'workspaces'].includes(parts[1] ?? '') &&
      parts[3] === 'palette'
    ) {
      return new Response(JSON.stringify({ palette: {} }), { status: 200 })
    }

    if (parts[0] === 'api' && parts[1] === 'canvas' && parts[4] === 'update' && method === 'POST') {
      const canvasId = `${parts[2]}/${decodeURIComponent(parts[3])}`
      const doc = ensureCanvas(state, canvasId)
      doc.import(await decodeBinaryBody(init?.body))
      return new Response(null, { status: 204 })
    }

    throw new Error(`Unexpected fetch: ${url.toString()}`)
  })
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
  return {
    fetchMock,
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }
}

function readElements(state: HarnessState, canvasId: string): CanvasElement[] {
  return ensureCanvas(state, canvasId).getMovableList('elements').toJSON() as CanvasElement[]
}

function countLiveElements(state: HarnessState, canvasId: string): number {
  return readElements(state, canvasId).filter((el) => el.isDeleted !== true).length
}

function readElement(state: HarnessState, canvasId: string, elementId: string): CanvasElement {
  const element = readElements(state, canvasId).find((el) => el.id === elementId)
  if (!element) throw new Error(`Element "${elementId}" not found`)
  return element
}

function mutateElement(
  state: HarnessState,
  canvasId: string,
  elementId: string,
  patch: Record<string, unknown>,
): void {
  const doc = ensureCanvas(state, canvasId)
  const list = doc.getMovableList('elements')
  for (let i = 0; i < list.length; i++) {
    const map = list.get(i)
    if (!(map instanceof LoroMap)) continue
    if (map.get('id') !== elementId) continue
    for (const [key, value] of Object.entries(patch)) {
      map.set(key, value as Parameters<LoroMap['set']>[1])
    }
    doc.commit()
    return
  }
  throw new Error(`Element "${elementId}" not found`)
}

function toRect(element: CanvasElement): Rect {
  return { x: element.x, y: element.y, width: element.width, height: element.height }
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

function arrowAbsolutePoints(arrow: CanvasElement): Point[] {
  return (arrow.points ?? []).map(([dx, dy]) => ({ x: arrow.x + dx, y: arrow.y + dy }))
}

function distancePointToSegment(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y)
  const t = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)),
  )
  const projX = start.x + dx * t
  const projY = start.y + dy * t
  return Math.hypot(point.x - projX, point.y - projY)
}

function distancePointToRect(point: Point, rect: Rect): number {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width))
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height))
  return Math.hypot(dx, dy)
}

function segmentIntersectsRect(start: Point, end: Point, rect: Rect): boolean {
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (dx === 0 && dy === 0) {
    return (
      start.x >= rect.x &&
      start.x <= rect.x + rect.width &&
      start.y >= rect.y &&
      start.y <= rect.y + rect.height
    )
  }
  let t0 = 0
  let t1 = 1
  const p = [-dx, dx, -dy, dy]
  const q = [
    start.x - rect.x,
    rect.x + rect.width - start.x,
    start.y - rect.y,
    rect.y + rect.height - start.y,
  ]
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false
      continue
    }
    const t = q[i] / p[i]
    if (p[i] < 0) {
      if (t > t1) return false
      if (t > t0) t0 = t
    } else {
      if (t < t0) return false
      if (t < t1) t1 = t
    }
  }
  return t0 <= t1
}

function distanceRectToSegment(rect: Rect, start: Point, end: Point): number {
  if (segmentIntersectsRect(start, end, rect)) return 0
  if (start.x === end.x) {
    const segMinY = Math.min(start.y, end.y)
    const segMaxY = Math.max(start.y, end.y)
    const overlapsY = rect.y <= segMaxY && rect.y + rect.height >= segMinY
    if (overlapsY) {
      return Math.max(rect.x - start.x, start.x - (rect.x + rect.width), 0)
    }
  }
  if (start.y === end.y) {
    const segMinX = Math.min(start.x, end.x)
    const segMaxX = Math.max(start.x, end.x)
    const overlapsX = rect.x <= segMaxX && rect.x + rect.width >= segMinX
    if (overlapsX) {
      return Math.max(rect.y - start.y, start.y - (rect.y + rect.height), 0)
    }
  }
  const corners: Point[] = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x, y: rect.y + rect.height },
    { x: rect.x + rect.width, y: rect.y + rect.height },
  ]
  return Math.min(
    distancePointToRect(start, rect),
    distancePointToRect(end, rect),
    ...corners.map((corner) => distancePointToSegment(corner, start, end)),
  )
}

function distanceRectToPolyline(rect: Rect, polyline: Point[]): number {
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i < polyline.length - 1; i++) {
    best = Math.min(best, distanceRectToSegment(rect, polyline[i], polyline[i + 1]))
  }
  return best
}

describe('canvas_auto_layout', () => {
  let state: HarnessState
  let restoreFetch: () => void
  let originalEnv: string | undefined

  beforeEach(() => {
    state = { canvases: new Map() }
    restoreFetch = installFetchMock(state).restore
    originalEnv = process.env.WHITEBOARD_MCP_DEBUG_AUTO_LAYOUT
  })

  afterEach(() => {
    restoreFetch()
    if (originalEnv === undefined) delete process.env.WHITEBOARD_MCP_DEBUG_AUTO_LAYOUT
    else process.env.WHITEBOARD_MCP_DEBUG_AUTO_LAYOUT = originalEnv
    vi.restoreAllMocks()
  })

  it('case 57', async () => {
    const canvasId = 'sid/precision-main'
    const annotate = annotateTool()
    const autoLayout = canvasAutoLayoutTool()

    const source = await annotate.execute(
      {
        canvasId,
        type: 'rectangle',
        coords: 'absolute',
        target: { x: 40, y: 40 },
        width: 120,
        height: 60,
      },
      client,
    )
    const target = await annotate.execute(
      {
        canvasId,
        type: 'rectangle',
        coords: 'absolute',
        target: { x: 260, y: 40 },
        width: 120,
        height: 60,
      },
      client,
    )
    const nearbyText = await annotate.execute(
      {
        canvasId,
        type: 'text',
        coords: 'absolute',
        target: { x: 188, y: 46 },
        text: 'note',
        width: 44,
        height: 24,
      },
      client,
    )
    const obstacle = await annotate.execute(
      {
        canvasId,
        type: 'text',
        coords: 'absolute',
        target: { x: 72, y: 126 },
        text: 'obstacle',
        width: 88,
        height: 24,
      },
      client,
    )
    const arrow = await annotate.execute(
      {
        canvasId,
        type: 'arrow',
        coords: 'absolute',
        target: { x: 100, y: 70 },
        endTarget: { x: 320, y: 70 },
        startBoxId: source.elementId,
        endBoxId: target.elementId,
        label: 'sync',
      },
      client,
    )

    const labelId = arrow.annotation?.labelId
    const arrowId = arrow.annotation?.arrowId
    expect(labelId).toBeDefined()
    expect(arrowId).toBeDefined()

    const oldLabel = readElement(state, canvasId, labelId!)
    const oldNearbyText = readElement(state, canvasId, nearbyText.elementId)

    await autoLayout.execute({ canvasId }, client)

    const nextArrow = readElement(state, canvasId, arrowId!)
    const nextLabel = readElement(state, canvasId, labelId!)
    const nextObstacle = readElement(state, canvasId, obstacle.elementId)
    const nextNearbyText = readElement(state, canvasId, nearbyText.elementId)
    expect(distanceRectToPolyline(toRect(nextLabel), arrowAbsolutePoints(nextArrow))).toBeLessThan(
      50,
    )
    expect(rectsOverlap(toRect(nextLabel), toRect(nextObstacle))).toBe(false)
    expect(Math.hypot(nextLabel.x - oldLabel.x, nextLabel.y - oldLabel.y)).toBeGreaterThan(80)
    expect(nextNearbyText.x).toBe(oldNearbyText.x)
    expect(nextNearbyText.y).toBe(oldNearbyText.y)
  })

  it('case 58', async () => {
    const canvasId = 'sid/precision-legacy'
    const annotate = annotateTool()
    const autoLayout = canvasAutoLayoutTool()

    const source = await annotate.execute(
      {
        canvasId,
        type: 'rectangle',
        coords: 'absolute',
        target: { x: 40, y: 40 },
        width: 120,
        height: 60,
      },
      client,
    )
    const target = await annotate.execute(
      {
        canvasId,
        type: 'rectangle',
        coords: 'absolute',
        target: { x: 260, y: 40 },
        width: 120,
        height: 60,
      },
      client,
    )
    const arrow = await annotate.execute(
      {
        canvasId,
        type: 'arrow',
        coords: 'absolute',
        target: { x: 100, y: 70 },
        endTarget: { x: 320, y: 70 },
        startBoxId: source.elementId,
        endBoxId: target.elementId,
        label: 'persist',
      },
      client,
    )

    const labelId = arrow.annotation?.labelId
    expect(labelId).toBeDefined()
    mutateElement(state, canvasId, labelId!, { isArrowLabel: false })

    const decoy = await annotate.execute(
      {
        canvasId,
        type: 'text',
        coords: 'absolute',
        target: { x: 150, y: 54 },
        text: 'extra',
        width: 55,
        height: 24,
      },
      client,
    )

    const oldLabel = readElement(state, canvasId, labelId!)
    const oldDecoy = readElement(state, canvasId, decoy.elementId)

    await autoLayout.execute({ canvasId }, client)

    const nextArrow = readElement(state, canvasId, arrow.annotation!.arrowId!)
    const nextLabel = readElement(state, canvasId, labelId!)
    const nextDecoy = readElement(state, canvasId, decoy.elementId)

    expect(distanceRectToPolyline(toRect(nextLabel), arrowAbsolutePoints(nextArrow))).toBeLessThan(
      50,
    )
    expect(Math.hypot(nextLabel.x - oldLabel.x, nextLabel.y - oldLabel.y)).toBeGreaterThan(80)
    expect(nextDecoy.x).toBe(oldDecoy.x)
    expect(nextDecoy.y).toBe(oldDecoy.y)
  })

  it('case 59', async () => {
    const canvasId = 'sid/debug'
    const annotate = annotateTool()
    const autoLayout = canvasAutoLayoutTool()
    const { captureLogsForTests } = await import('../../log.js')
    const cap = captureLogsForTests('debug')

    try {
      await annotate.execute(
        {
          canvasId,
          type: 'rectangle',
          coords: 'absolute',
          target: { x: 200, y: 200 },
          width: 120,
          height: 60,
        },
        client,
      )

      delete process.env.WHITEBOARD_MCP_DEBUG_AUTO_LAYOUT
      const withoutDebug = await autoLayout.execute({ canvasId }, client)
      expect(withoutDebug).toEqual({
        nodeCount: 1,
        edgeCount: 0,
        movedCount: 1,
      })
      expect(Object.keys(withoutDebug).sort()).toEqual(['edgeCount', 'movedCount', 'nodeCount'])
      // canvas_auto_layout records may not appear, but other infrastructure
      // (e.g. snapshot warnings) might. Filter to the layout scope only.
      expect(cap.records.filter((r) => r.scope === 'canvas_auto_layout')).toHaveLength(0)

      process.env.WHITEBOARD_MCP_DEBUG_AUTO_LAYOUT = '1'
      await autoLayout.execute({ canvasId }, client)
      const layoutCalls = cap.records.filter((r) => r.scope === 'canvas_auto_layout')
      expect(layoutCalls).toHaveLength(1)
      const record = layoutCalls[0]
      expect(record.level).toBe('debug')
      expect(record.msg).toBe('layout pass complete')
      const payload = record.data
      expect(payload).toMatchObject({
        canvasId,
        timingsMs: {
          snapshotLoad: expect.any(Number),
          graphExtract: expect.any(Number),
          layoutSolve: expect.any(Number),
          arrowRebindAndLabelRelocate: expect.any(Number),
          updatePost: expect.any(Number),
        },
      })
    } finally {
      cap.restore()
    }
  })
})

describe('layout regression cases', () => {
  let state: HarnessState
  let restoreFetch: () => void

  beforeEach(() => {
    state = { canvases: new Map() }
    restoreFetch = installFetchMock(state).restore
  })

  afterEach(() => {
    restoreFetch()
    vi.restoreAllMocks()
  })

  it('case 60', async () => {
    const canvasId = 'sid/architecture'
    const batch = annotateBatchTool()
    const autoLayout = canvasAutoLayoutTool()

    const res = await batch.execute(
      {
        canvasId,
        annotations: [
          {
            type: 'box_with_label',
            name: 'client',
            coords: 'absolute',
            target: { x: 40, y: 40 },
            width: 140,
            height: 60,
            text: 'Client',
          },
          {
            type: 'box_with_label',
            name: 'browser',
            coords: 'absolute',
            target: { x: 320, y: 40 },
            width: 160,
            height: 60,
            text: 'Browser',
          },
          {
            type: 'arrow',
            coords: 'absolute',
            target: { x: 110, y: 70 },
            endTarget: { x: 400, y: 70 },
            startBoxName: 'client',
            endBoxName: 'browser',
            label: 'request',
          },
        ],
      },
      client,
    )

    await autoLayout.execute({ canvasId }, client)

    const arrowId = res.annotations?.[2].arrowId
    const labelId = res.annotations?.[2].labelId
    const clientRectId = res.annotations?.[0].rectId
    const browserRectId = res.annotations?.[1].rectId
    expect(arrowId).toBeDefined()
    expect(labelId).toBeDefined()
    expect(clientRectId).toBeDefined()
    expect(browserRectId).toBeDefined()

    const arrow = readElement(state, canvasId, arrowId!)
    const label = readElement(state, canvasId, labelId!)
    const clientRect = readElement(state, canvasId, clientRectId!)
    const browserRect = readElement(state, canvasId, browserRectId!)

    expect(distanceRectToPolyline(toRect(label), arrowAbsolutePoints(arrow))).toBeLessThan(50)
    expect(rectsOverlap(toRect(label), toRect(clientRect))).toBe(false)
    expect(rectsOverlap(toRect(label), toRect(browserRect))).toBe(false)
  })

  it('section rewrite flow: assign_to_group -> delete_group -> annotate_batch -> create_frame/update_frame_members', async () => {
    const canvasId = 'sid/section-rewrite'
    const batch = annotateBatchTool()
    const assignToGroup = assignToGroupTool()
    const deleteGroup = deleteGroupTool()
    const createFrame = createFrameTool()
    const updateFrameMembers = updateFrameMembersTool()

    const oldSection = await batch.execute(
      {
        canvasId,
        annotations: [
          {
            type: 'rectangle',
            coords: 'absolute',
            target: { x: 40, y: 40 },
            width: 120,
            height: 60,
          },
          {
            type: 'rectangle',
            coords: 'absolute',
            target: { x: 200, y: 40 },
            width: 120,
            height: 60,
          },
        ],
      },
      client,
    )
    await assignToGroup.execute(
      { canvasId, groupId: 'section-before', elementIds: oldSection.elementIds },
      client,
    )
    const deleted = await deleteGroup.execute({ canvasId, groupId: 'section-before' }, client)
    expect(deleted.deletedCount).toBe(2)

    const newSection = await batch.execute(
      {
        canvasId,
        annotations: [
          {
            type: 'box_with_label',
            coords: 'absolute',
            target: { x: 60, y: 180 },
            width: 160,
            height: 70,
            text: 'Section A',
          },
          {
            type: 'rectangle',
            coords: 'absolute',
            target: { x: 280, y: 180 },
            width: 120,
            height: 70,
          },
        ],
      },
      client,
    )

    const primaryRectId = newSection.annotations?.[0].rectId
    const secondaryRectId = newSection.annotations?.[1].elementId
    expect(primaryRectId).toBeDefined()
    expect(secondaryRectId).toBeDefined()

    const frame = await createFrame.execute(
      { canvasId, memberIds: [primaryRectId!], padding: 12, name: 'Section Frame' },
      client,
    )
    await updateFrameMembers.execute(
      { canvasId, frameId: frame.elementId, add: [secondaryRectId!], padding: 12 },
      client,
    )

    const elements = readElements(state, canvasId)
    const oldRects = oldSection.elementIds.map((id) => readElement(state, canvasId, id))
    const primaryRect = readElement(state, canvasId, primaryRectId!)
    const secondaryRect = readElement(state, canvasId, secondaryRectId!)
    const nextFrame = readElement(state, canvasId, frame.elementId)

    expect(oldRects.every((el) => el.isDeleted === true)).toBe(true)
    expect(primaryRect.frameId).toBe(frame.elementId)
    expect(secondaryRect.frameId).toBe(frame.elementId)
    expect(nextFrame.type).toBe('frame')
    expect(nextFrame.x).toBeLessThanOrEqual(Math.min(primaryRect.x, secondaryRect.x))
    expect(nextFrame.y).toBeLessThanOrEqual(Math.min(primaryRect.y, secondaryRect.y))
    expect(nextFrame.x + nextFrame.width).toBeGreaterThanOrEqual(
      Math.max(primaryRect.x + primaryRect.width, secondaryRect.x + secondaryRect.width),
    )
    expect(nextFrame.y + nextFrame.height).toBeGreaterThanOrEqual(
      Math.max(primaryRect.y + primaryRect.height, secondaryRect.y + secondaryRect.height),
    )
    expect(
      elements
        .filter((el) => el.frameId === frame.elementId && el.isDeleted !== true)
        .map((el) => el.id)
        .sort(),
    ).toEqual([primaryRectId!, secondaryRectId!].sort())
  })
})
