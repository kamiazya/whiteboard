import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { GestureResult } from './gestures.js'
import { useNodeCreation } from './use-node-creation.js'

const overlaps = (a: SpatialNode, b: SpatialNode) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

function mount(canvas: SpatialCanvas) {
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
      containerSizeOf: () => null,
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
