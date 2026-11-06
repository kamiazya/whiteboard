import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ContainerSize } from '../../lib/spatial/viewport.js'
import type { GestureResult } from './gestures.js'
import { bottomChromeOcclusionPx } from './ToolPalette.js'

/** The one-row dock's strip: the floor the measured occlusion answers with when nothing is measured. */
const DOCK_OCCLUSION_PX = bottomChromeOcclusionPx(null)

import { useNodeCreation } from './use-node-creation.js'

const overlaps = (a: SpatialNode, b: SpatialNode) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

function mount(canvas: SpatialCanvas, container: ContainerSize | null = null) {
  const results: GestureResult[] = []
  const { result } = renderHook(() =>
    useNodeCreation({
      rootRef: { current: null },
      canvasRef: { current: canvas },
      viewport: { x: 0, y: 0, zoom: 1 },
      setViewport: () => {},
      createId: () => 'new-frame',
      fileRefOptions: undefined,
      applyResult: (r) => results.push(r),
      collapseExtras: () => {},
      containerSizeOf: () => container,
      openGroupLabel: vi.fn(),
    }),
  )
  const createdNode = () => {
    const command = results.at(-1)?.commands?.[0]
    if (command?.kind !== 'create-group') throw new Error('no frame was created')
    return command.node
  }
  return { creation: result.current, createdNode }
}

describe('a new frame asked for at a point', () => {
  const frontend = groupNode({ id: 'frontend', x: -160, y: -100, width: 320, height: 200 })
  const webApp = textNode({
    id: 'web-app',
    x: -60,
    y: -30,
    width: 120,
    height: 60,
    text: 'Web App',
  })

  it('goes to free space instead of on top of an existing frame and its notes', () => {
    const { creation, createdNode } = mount({ nodes: [frontend, webApp], edges: [] })
    creation.createGroupAtViewportCenter({ x: 0, y: 0 })
    const frame = createdNode()
    expect(overlaps(frame, frontend)).toBe(false)
    expect(overlaps(frame, webApp)).toBe(false)
  })

  it('stays at the point asked for when that space is free', () => {
    const { creation, createdNode } = mount({ nodes: [frontend], edges: [] })
    creation.createGroupAtViewportCenter({ x: 2000, y: 2000 })
    const frame = createdNode()
    expect(frame.x + frame.width / 2).toBe(2000)
    expect(frame.y + frame.height / 2).toBe(2000)
  })
})

describe('a new frame asked for from the dock', () => {
  /** The strip above a frame that its name and its selection chip draw into. */
  const strip = (frame: SpatialNode) => ({
    x: frame.x,
    y: frame.y - 50,
    width: frame.width,
    height: 50,
  })
  const meets = (a: { x: number; y: number; width: number; height: number }, b: SpatialNode) =>
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

  it('keeps the strip above it, where its name and chip go, clear of a note', () => {
    const note = textNode({ id: 'note', x: -100, y: -160, width: 200, height: 100, text: 'Idea' })
    const { creation, createdNode } = mount({ nodes: [note], edges: [] })
    creation.createGroupAtViewportCenter()
    const frame = createdNode()
    expect(overlaps(frame, note)).toBe(false)
    expect(meets(strip(frame), note)).toBe(false)
  })

  it('keeps that strip clear when it is asked for at a point, too', () => {
    const note = textNode({ id: 'note', x: -100, y: -160, width: 200, height: 100, text: 'Idea' })
    const { creation, createdNode } = mount({ nodes: [note], edges: [] })
    creation.createGroupAtViewportCenter({ x: 0, y: 0 })
    const frame = createdNode()
    expect(meets(strip(frame), note)).toBe(false)
  })
})

describe('a new frame beside other boxes', () => {
  /** The empty space between two boxes along whichever axis separates them. */
  const gapBetween = (a: SpatialNode, b: SpatialNode) =>
    Math.max(
      b.x - (a.x + a.width),
      a.x - (b.x + b.width),
      b.y - (a.y + a.height),
      a.y - (b.y + b.height),
    )

  // A frame asked for just right of a note: its left edge would sit 5px from it.
  const note = textNode({ id: 'note', x: -200, y: -50, width: 200, height: 100, text: 'Idea' })

  it('keeps the clearance boxes keep from a note it would sit next to', () => {
    const { creation, createdNode } = mount({ nodes: [note], edges: [] })
    creation.createGroupAtViewportCenter({ x: 165, y: 0 })
    expect(gapBetween(createdNode(), note)).toBeGreaterThanOrEqual(32)
  })

  it('stays at the point asked for when it is already that far from everything', () => {
    const { creation, createdNode } = mount({ nodes: [note], edges: [] })
    creation.createGroupAtViewportCenter({ x: 200, y: 0 })
    const frame = createdNode()
    expect(frame.x + frame.width / 2).toBe(200)
    expect(frame.y + frame.height / 2).toBe(0)
  })

  it('gives the clearance up before it gives up staying on screen', () => {
    // A view 410 wide and 260 tall over a tall note at its left edge: a
    // 320-wide frame fits beside the note only closer than the gap.
    const tall = textNode({ id: 'tall', x: 0, y: 0, width: 60, height: 200, text: 'Idea' })
    const { creation, createdNode } = mount(
      { nodes: [tall], edges: [] },
      { width: 410, height: 260 + DOCK_OCCLUSION_PX },
    )
    creation.createGroupAtViewportCenter({ x: 195, y: 130 })
    const frame = createdNode()
    expect(overlaps(frame, tall)).toBe(false)
    expect(frame.x).toBeGreaterThanOrEqual(0)
    expect(frame.y).toBeGreaterThanOrEqual(0)
    expect(frame.x + frame.width).toBeLessThanOrEqual(410)
    expect(frame.y + frame.height).toBeLessThanOrEqual(260)
  })
})
