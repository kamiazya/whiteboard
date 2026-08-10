// An edge between two members of the same group must run inside the group's
// frame. The group's rect used to be treated as an obstacle, and since no
// detour can ever clear a rect that contains the edge's endpoints, the router
// fell back to the shortest detour AROUND the whole frame — a hairpin dipping
// below the group.
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

// The reported arrangement: a group with two members stacked vertically, one
// node above the group and one to its left, each wired to the upper member.
const canvas: SpatialCanvas = {
  nodes: [
    { id: 'g', type: 'group', x: 200, y: 170, width: 400, height: 380, label: 'あああ' },
    { id: 'sore', type: 'text', x: 330, y: 210, width: 180, height: 140, text: 'それ' },
    { id: 'are', type: 'text', x: 350, y: 420, width: 160, height: 90, text: 'あれ' },
    { id: 'acc', type: 'text', x: 330, y: 20, width: 180, height: 90, text: 'acc' },
    { id: 'left', type: 'text', x: 20, y: 250, width: 140, height: 90, text: 'left' },
  ],
  edges: [
    { id: 'e-acc', fromNode: 'acc', toNode: 'sore' },
    { id: 'e-left', fromNode: 'left', toNode: 'sore' },
    { id: 'e-members', fromNode: 'sore', toNode: 'are' },
  ],
}

const parsePoints = (polyline: SVGPolylineElement): { x: number; y: number }[] =>
  (polyline.getAttribute('points') ?? '')
    .trim()
    .split(/\s+/)
    .map((pair) => {
      const [x, y] = pair.split(',').map(Number)
      return { x: x as number, y: y as number }
    })

it('routes an edge between two group members inside the group frame', async () => {
  const { container } = render(
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor defaultTool="select" canvas={canvas} onChange={() => {}} theme="light" />
    </div>,
  )

  await vi.waitFor(() => {
    expect(container.querySelectorAll('svg polyline').length).toBeGreaterThanOrEqual(3)
  })

  // それ bottom-center → あれ top-center, the member-to-member edge.
  const paths = [...container.querySelectorAll('svg polyline')].map((el) =>
    parsePoints(el as SVGPolylineElement),
  )
  const memberEdge = paths.find((p) => p[0]?.x === 420 && p[0]?.y === 350)
  expect(memberEdge).toBeDefined()

  // A clear straight run: endpoint to endpoint, never leaving the frame.
  expect(memberEdge).toEqual([
    { x: 420, y: 350 },
    { x: 430, y: 420 },
  ])
})
