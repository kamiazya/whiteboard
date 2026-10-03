// @vitest-environment node

import type { ClipboardFragment, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { endNode, nodeText, spatialCanvasSchema } from '@kamiazya/whiteboard-model'
import { fileNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { applyCommand, type EditorCommand } from './commands.js'
import { buildFragmentInsertCommand, DUPLICATE_OFFSET_PX } from './fragment-insert.js'

function baseCanvas(): SpatialCanvas {
  return {
    nodes: [
      textNode({ id: 'a', x: 0, y: 0, width: 100, height: 50, text: 'hello' }),
      fileNode({ id: 'b', x: 200, y: 0, width: 80, height: 40, file: 'x.png' }),
    ],
    edges: [],
  }
}

describe('buildFragmentInsertCommand carries ink', () => {
  const strokeFragment = {
    nodes: [],
    edges: [],
    lines: [
      {
        id: 'l1',
        from: { kind: 'point' as const, point: { x: 100, y: 100 } },
        to: { kind: 'point' as const, point: { x: 200, y: 200 } },
        bends: [{ x: 150, y: 120 }],
      },
    ],
  }

  it('pastes a stroke on its own, where a fragment of pure ink used to be nothing', () => {
    // The guard was `fragment.nodes.length === 0`, so a copied stroke and an
    // empty clipboard answered the same way.
    const command = buildFragmentInsertCommand(baseCanvas(), strokeFragment, () => 'fresh')
    expect(command?.kind).toBe('batch')
    const next = applyCommand(baseCanvas(), command as EditorCommand)
    expect(next.lines).toHaveLength(1)
    expect(() => spatialCanvasSchema.parse(next)).not.toThrow()
  })

  it('offsets every point the stroke owns, so the copy lands beside the original', () => {
    const next = applyCommand(
      baseCanvas(),
      buildFragmentInsertCommand(baseCanvas(), strokeFragment, () => 'fresh') as EditorCommand,
    )
    const line = next.lines?.[0]
    // The same +16 cascade a duplicated node takes.
    expect(line?.from).toEqual({
      kind: 'point',
      point: { x: 100 + DUPLICATE_OFFSET_PX, y: 100 + DUPLICATE_OFFSET_PX },
    })
    expect(line?.bends).toEqual([{ x: 150 + DUPLICATE_OFFSET_PX, y: 120 + DUPLICATE_OFFSET_PX }])
  })

  it('centres an ink-only paste on the anchor, reading the stroke for its bounds', () => {
    // A node-only bounds computation answers Infinity here, so "paste here"
    // put the stroke nowhere a person could find it.
    const next = applyCommand(
      baseCanvas(),
      buildFragmentInsertCommand(baseCanvas(), strokeFragment, () => 'fresh', {
        x: 500,
        y: 500,
      }) as EditorCommand,
    )
    const line = next.lines?.[0]
    const from = line?.from.kind === 'point' ? line.from.point : undefined
    const to = line?.to.kind === 'point' ? line.to.point : undefined
    expect(from).toBeDefined()
    expect(to).toBeDefined()
    // The stroke spans 100..200 on both axes, so its middle lands on 500,500.
    expect(((from?.x ?? 0) + (to?.x ?? 0)) / 2).toBe(500)
    expect(((from?.y ?? 0) + (to?.y ?? 0)) / 2).toBe(500)
  })
})

describe('buildFragmentInsertCommand', () => {
  // Shared core of pasteFragment (with/without an anchor) and
  // duplicateSelection (always cascades, never anchors).
  const fragment = (): Pick<ClipboardFragment, 'nodes' | 'edges'> => ({
    nodes: [
      textNode({ id: 'src-a', x: 0, y: 0, width: 100, height: 50, text: 'a' }),
      textNode({ id: 'src-b', x: 150, y: 20, width: 60, height: 40, text: 'b' }),
    ],
    edges: [
      {
        id: 'src-e',
        from: { node: 'src-a' },
        to: { node: 'src-b' },
        label: 'link',
      },
    ],
  })
  const sequentialIds = () => {
    let n = 0
    return () => `new-${n++}`
  }

  it('a cut fragment reconnects its boundary edges to surviving peers, reminted on the cut side', () => {
    // The peer stayed on the canvas; the cut node comes back with a new id.
    const canvas: SpatialCanvas = {
      nodes: [textNode({ id: 'peer', x: 400, y: 0, width: 100, height: 50, text: 'peer' })],
      edges: [],
    }
    const cutFragment = {
      ...fragment(),
      cut: {
        id: 'cut-1',
        boundaryEdges: [
          {
            id: 'src-boundary',
            from: { node: 'src-b' },
            to: { node: 'peer' },
            label: 'kept',
          },
          // This peer is gone (cross-canvas, or deleted since): silently dropped.
          {
            id: 'src-gone',
            from: { node: 'src-a' },
            to: { node: 'vanished' },
          },
        ],
      },
    }
    const command = buildFragmentInsertCommand(canvas, cutFragment, sequentialIds())
    if (command?.kind !== 'batch') throw new Error('expected a batch command')
    const edgeCommands = command.commands.filter((c) => c.kind === 'create-edge')
    const nodeCommands = command.commands.filter((c) => c.kind === 'create-node')
    const remintedB = nodeCommands.find((c) => nodeText(c.node) === 'b')?.node.id
    expect(remintedB).toBeDefined()
    const boundary = edgeCommands.find((c) => c.edge.label === 'kept')?.edge
    expect(boundary).toMatchObject({
      from: { node: remintedB },
      to: { node: 'peer' },
    })
    expect(boundary?.id).not.toBe('src-boundary')
    expect(edgeCommands.some((c) => endNode(c.edge.to) === 'vanished')).toBe(false)
  })

  it('never reconnects a boundary edge whose original still exists — a lifted cut was not severed', () => {
    const canvas: SpatialCanvas = {
      nodes: [
        textNode({ id: 'src-b', x: 150, y: 20, width: 60, height: 40, text: 'b' }),
        textNode({ id: 'peer', x: 400, y: 0, width: 100, height: 50, text: 'peer' }),
      ],
      // The severed edge is still on the canvas: the hold was lifted (or
      // resolved as a move), so this paste is a plain duplicate.
      edges: [
        {
          id: 'src-boundary',
          from: { node: 'src-b' },
          to: { node: 'peer' },
        },
      ],
    }
    const cutFragment = {
      ...fragment(),
      cut: {
        id: 'cut-1',
        boundaryEdges: [
          {
            id: 'src-boundary',
            from: { node: 'src-b' },
            to: { node: 'peer' },
          },
        ],
      },
    }
    const command = buildFragmentInsertCommand(canvas, cutFragment, sequentialIds())
    if (command?.kind !== 'batch') throw new Error('expected a batch command')
    const edgeCommands = command.commands.filter((c) => c.kind === 'create-edge')
    expect(edgeCommands.some((c) => endNode(c.edge.to) === 'peer')).toBe(false)
  })

  it('returns undefined for an empty-node fragment', () => {
    const canvas: SpatialCanvas = { nodes: [], edges: [] }
    expect(buildFragmentInsertCommand(canvas, { nodes: [], edges: [] }, sequentialIds())).toBe(
      undefined,
    )
  })

  it('without an anchor, offsets every node +16/+16 (the duplicate cascade)', () => {
    const canvas: SpatialCanvas = { nodes: [], edges: [] }
    const command = buildFragmentInsertCommand(canvas, fragment(), sequentialIds())
    if (command?.kind !== 'batch') throw new Error('expected a batch command')
    const nodeCommands = command.commands.filter((c) => c.kind === 'create-node')
    expect(nodeCommands.map((c) => ({ x: c.node.x, y: c.node.y }))).toEqual([
      { x: 16, y: 16 },
      { x: 166, y: 36 },
    ])
  })

  it('with an anchor, the reminted bbox center lands on the anchor (rounded)', () => {
    const canvas: SpatialCanvas = { nodes: [], edges: [] }
    const command = buildFragmentInsertCommand(canvas, fragment(), sequentialIds(), {
      x: 500,
      y: 500,
    })
    if (command?.kind !== 'batch') throw new Error('expected a batch command')
    const nodeCommands = command.commands.filter((c) => c.kind === 'create-node')
    const xs = nodeCommands.map((c) => c.node.x)
    const ys = nodeCommands.map((c) => c.node.y)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs.map((x, i) => x + nodeCommands[i].node.width))
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys.map((y, i) => y + nodeCommands[i].node.height))
    expect(Math.round((minX + maxX) / 2)).toBe(500)
    expect(Math.round((minY + maxY) / 2)).toBe(500)
  })

  it('preserves edge properties and remaps endpoints to the reminted ids', () => {
    const canvas: SpatialCanvas = { nodes: [], edges: [] }
    const command = buildFragmentInsertCommand(canvas, fragment(), sequentialIds())
    if (command?.kind !== 'batch') throw new Error('expected a batch command')
    const nodeIds = command.commands.filter((c) => c.kind === 'create-node').map((c) => c.node.id)
    const edgeCommands = command.commands.filter((c) => c.kind === 'create-edge')
    expect(edgeCommands).toHaveLength(1)
    expect(edgeCommands[0].edge.label).toBe('link')
    expect(nodeIds).toContain(endNode(edgeCommands[0].edge.from))
    expect(nodeIds).toContain(endNode(edgeCommands[0].edge.to))
  })

  it('reminted ids are disjoint from existing canvas node+edge ids', () => {
    const canvas: SpatialCanvas = {
      nodes: [textNode({ id: 'new-0', x: 0, y: 0, width: 10, height: 10, text: '' })],
      edges: [],
    }
    const command = buildFragmentInsertCommand(canvas, fragment(), sequentialIds())
    if (command?.kind !== 'batch') throw new Error('expected a batch command')
    const nodeIds = command.commands.filter((c) => c.kind === 'create-node').map((c) => c.node.id)
    expect(nodeIds).not.toContain('new-0')
  })

  it('applying the built command to the source canvas adds exactly fragment.nodes.length nodes', () => {
    const canvas: SpatialCanvas = { nodes: [], edges: [] }
    const command = buildFragmentInsertCommand(canvas, fragment(), sequentialIds())
    if (command === undefined) throw new Error('expected a command')
    const next = applyCommand(canvas, command)
    expect(next.nodes).toHaveLength(2)
  })

  it('duplicateSelection parity: an edge with one endpoint outside the fragment is dropped', () => {
    // Mirrors extractClipboardFragment's own contract — the fragment never
    // arrives with a dangling edge, so the builder need not special-case it,
    // but this pins that the whole pipeline still drops it end to end.
    const canvas: SpatialCanvas = { nodes: [], edges: [] }
    const partial: Pick<ClipboardFragment, 'nodes' | 'edges'> = {
      nodes: [textNode({ id: 'src-a', x: 0, y: 0, width: 100, height: 50, text: 'a' })],
      edges: [
        {
          id: 'src-e',
          from: { node: 'src-a' },
          to: { node: 'not-included' },
        },
      ],
    }
    const command = buildFragmentInsertCommand(canvas, partial, sequentialIds())
    if (command?.kind !== 'batch') throw new Error('expected a batch command')
    expect(command.commands.filter((c) => c.kind === 'create-edge')).toHaveLength(0)
  })
})
