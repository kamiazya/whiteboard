import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { selectCanvasFragment } from './canvas-fragment.js'

const text = (id: string, x: number, y: number) =>
  ({ id, type: 'text', x, y, width: 100, height: 50, text: id }) as const

const canvas: SpatialCanvas = {
  nodes: [
    text('outside', 500, 500),
    { id: 'g-launch', type: 'group', x: 0, y: 0, width: 400, height: 300, label: 'Launch' },
    text('in-launch', 10, 10),
    { id: 'g-inner', type: 'group', x: 150, y: 150, width: 100, height: 100, label: 'inner' },
    text('half-out', 350, 10),
    { id: 'g-launch-2', type: 'group', x: 600, y: 0, width: 200, height: 200, label: 'launch' },
    text('in-second', 610, 10),
  ],
  edges: [
    { id: 'e-in', fromNode: 'in-launch', toNode: 'g-inner' },
    { id: 'e-out', fromNode: 'in-launch', toNode: 'outside' },
  ],
}

describe('selectCanvasFragment', () => {
  it('a label selects the group, the nodes inside its box, and the edges between them', () => {
    const selected = selectCanvasFragment(canvas, 'Launch')
    expect(selected?.nodes.map((n) => n.id)).toEqual(['g-launch', 'in-launch', 'g-inner'])
    expect(selected?.edges.map((e) => e.id)).toEqual(['e-in'])
  })

  it('an exact label beats a case-insensitive one; the fallback still finds the other', () => {
    expect(selectCanvasFragment(canvas, 'Launch')?.nodes[0]?.id).toBe('g-launch')
    expect(selectCanvasFragment(canvas, 'launch')?.nodes[0]?.id).toBe('g-launch-2')
    expect(selectCanvasFragment(canvas, 'LAUNCH')?.nodes[0]?.id).toBe('g-launch')
  })

  it('^id is the durable form: a group by id, or one plain node on its own', () => {
    expect(selectCanvasFragment(canvas, '^g-inner')?.nodes.map((n) => n.id)).toEqual(['g-inner'])
    const one = selectCanvasFragment(canvas, '^outside')
    expect(one?.nodes.map((n) => n.id)).toEqual(['outside'])
    expect(one?.edges).toEqual([])
  })

  it('an unknown label, an unknown id, and an empty fragment select nothing', () => {
    expect(selectCanvasFragment(canvas, 'Nope')).toBeUndefined()
    expect(selectCanvasFragment(canvas, '^nope')).toBeUndefined()
    expect(selectCanvasFragment(canvas, '  ')).toBeUndefined()
  })

  it('a text node whose label matches is not a section', () => {
    const only: SpatialCanvas = { nodes: [text('Launch', 0, 0)], edges: [] }
    expect(selectCanvasFragment(only, 'Launch')).toBeUndefined()
  })
})
