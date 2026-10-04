import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { NodeBox } from '../../lib/spatial/geometry.js'
import { MemberOutlinesOverlay } from './MemberOutlinesOverlay.js'

afterEach(cleanup)

const member = (id: string, x: number): NodeBox => ({
  id,
  box: { x, y: 0, width: 100, height: 50 },
})

const edges = [
  { id: 'inside', from: { node: 'a' }, to: { node: 'b' } },
  { id: 'leaving', from: { node: 'b' }, to: { node: 'c' } },
] as const
const edgePaths = [
  {
    id: 'inside',
    path: [
      { x: 100, y: 25 },
      { x: 200, y: 25 },
    ],
  },
  {
    id: 'leaving',
    path: [
      { x: 300, y: 25 },
      { x: 400, y: 25 },
    ],
  },
]

const drawnEdgeIds = (container: HTMLElement) =>
  [...container.querySelectorAll('polyline')].map((line) => line.getAttribute('data-edge-id'))

describe('MemberOutlinesOverlay', () => {
  it('outlines an edge only when both its ends are members, by default', () => {
    const { container } = render(
      <MemberOutlinesOverlay
        selectionMembers={[member('a', 0), member('b', 200)]}
        edges={edges}
        edgePaths={edgePaths}
        zoom={1}
      />,
    )
    expect(drawnEdgeIds(container)).toEqual(['inside'])
  })

  it('outlines exactly the named edges, whatever their ends', () => {
    const { container } = render(
      <MemberOutlinesOverlay
        selectionMembers={[member('a', 0), member('b', 200)]}
        edges={edges}
        edgePaths={edgePaths}
        outlinedEdgeIds={new Set(['leaving'])}
        zoom={1}
      />,
    )
    expect(drawnEdgeIds(container)).toEqual(['leaving'])
  })

  it('outlines a named edge when no node is a member', () => {
    const { container } = render(
      <MemberOutlinesOverlay
        selectionMembers={[]}
        edges={edges}
        edgePaths={edgePaths}
        outlinedEdgeIds={new Set(['inside'])}
        zoom={1}
      />,
    )
    expect(drawnEdgeIds(container)).toEqual(['inside'])
    expect(container.querySelectorAll('rect')).toHaveLength(0)
  })

  it('outlines a named route that is no edge at all, such as a stroke', () => {
    const { container } = render(
      <MemberOutlinesOverlay
        selectionMembers={[]}
        edgePaths={[...edgePaths, { id: 'stroke', path: edgePaths[0]?.path ?? [] }]}
        outlinedEdgeIds={new Set(['stroke'])}
        zoom={1}
      />,
    )
    expect(drawnEdgeIds(container)).toEqual(['stroke'])
  })
})
