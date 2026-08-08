import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { spatialCanvasSchema } from '@kamiazya/whiteboard-canvas-model'
import { describe, expect, it } from 'vitest'
import { applyCommand } from './commands.js'

function baseCanvas(): SpatialCanvas {
  return {
    nodes: [
      { id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hello' },
      { id: 'b', type: 'file', x: 200, y: 0, width: 80, height: 40, file: 'x.png' },
    ],
    edges: [],
  }
}

describe('applyCommand', () => {
  it('move-node changes only that node x/y, leaving everything else reference-equal', () => {
    const canvas = baseCanvas()
    const snapshot = structuredClone(canvas)
    const next = applyCommand(canvas, { kind: 'move-node', id: 'a', x: 10, y: 20 })

    expect(next).not.toBe(canvas)
    expect(next.nodes[0]).toEqual({ ...canvas.nodes[0], x: 10, y: 20 })
    expect(next.nodes[1]).toBe(canvas.nodes[1])
    expect(next.edges).toBe(canvas.edges)
    expect(canvas).toEqual(snapshot) // input untouched
  })

  it('resize-node keeps the opposite anchor fixed and clamps to non-negative integers', () => {
    const canvas = baseCanvas()
    const next = applyCommand(canvas, {
      kind: 'resize-node',
      id: 'a',
      x: 0,
      y: 0,
      width: -5.7,
      height: 30.4,
    })
    const node = next.nodes[0]
    expect(node).toMatchObject({ x: 0, y: 0, width: 0, height: 30 })
  })

  it('set-text changes only the text field of a text node', () => {
    const canvas = baseCanvas()
    const next = applyCommand(canvas, { kind: 'set-text', id: 'a', text: 'updated' })
    expect(next.nodes[0]).toEqual({ ...canvas.nodes[0], text: 'updated' })
  })

  it('set-text on a non-text node is a no-op returning the input canvas', () => {
    const canvas = baseCanvas()
    const next = applyCommand(canvas, { kind: 'set-text', id: 'b', text: 'nope' })
    expect(next).toBe(canvas)
  })

  it('connect-nodes appends exactly one edge and leaves nodes untouched', () => {
    const canvas = baseCanvas()
    const next = applyCommand(canvas, {
      kind: 'connect-nodes',
      edgeId: 'e1',
      fromNode: 'a',
      toNode: 'b',
    })
    expect(next.nodes).toBe(canvas.nodes)
    expect(next.edges).toEqual([{ id: 'e1', fromNode: 'a', toNode: 'b' }])
  })

  it('connect-nodes rejects a missing endpoint as a no-op', () => {
    const canvas = baseCanvas()
    const next = applyCommand(canvas, {
      kind: 'connect-nodes',
      edgeId: 'e1',
      fromNode: 'a',
      toNode: 'missing',
    })
    expect(next).toBe(canvas)
  })

  it('connect-nodes rejects self-connection as a no-op', () => {
    const canvas = baseCanvas()
    const next = applyCommand(canvas, {
      kind: 'connect-nodes',
      edgeId: 'e1',
      fromNode: 'a',
      toNode: 'a',
    })
    expect(next).toBe(canvas)
  })

  it('connect-nodes rejects a duplicate edge id as a no-op, keeping the canvas schema-valid', () => {
    const canvas = applyCommand(baseCanvas(), {
      kind: 'connect-nodes',
      edgeId: 'e1',
      fromNode: 'a',
      toNode: 'b',
    })
    const next = applyCommand(canvas, {
      kind: 'connect-nodes',
      edgeId: 'e1',
      fromNode: 'b',
      toNode: 'a',
    })
    expect(next).toBe(canvas)
    expect(next.edges).toEqual([{ id: 'e1', fromNode: 'a', toNode: 'b' }])
    expect(spatialCanvasSchema.safeParse(next).success).toBe(true)
  })

  it('is total: a command targeting a missing id returns the input unchanged', () => {
    const canvas = baseCanvas()
    const next = applyCommand(canvas, { kind: 'move-node', id: 'missing', x: 1, y: 1 })
    expect(next).toBe(canvas)
  })

  it('every produced canvas stays schema-valid', () => {
    const canvas = baseCanvas()
    const next = applyCommand(canvas, { kind: 'move-node', id: 'a', x: 5, y: 5 })
    expect(spatialCanvasSchema.safeParse(next).success).toBe(true)
  })

  it('create-node appends the node, leaving the input canvas untouched', () => {
    const canvas = baseCanvas()
    const snapshot = structuredClone(canvas)
    const newNode = {
      id: 'c',
      type: 'text',
      x: 400,
      y: 0,
      width: 100,
      height: 50,
      text: '',
    } as const
    const next = applyCommand(canvas, { kind: 'create-node', node: newNode })

    expect(next).not.toBe(canvas)
    expect(next.nodes).toEqual([...canvas.nodes, newNode])
    expect(canvas).toEqual(snapshot)
    expect(spatialCanvasSchema.safeParse(next).success).toBe(true)
  })

  it('create-node with an id already present is a no-op returning the input canvas', () => {
    const canvas = baseCanvas()
    const dup = { id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'dup' } as const
    const next = applyCommand(canvas, { kind: 'create-node', node: dup })
    expect(next).toBe(canvas)
  })

  it('delete-node removes the node and every edge referencing it, leaving the rest untouched', () => {
    const connected = applyCommand(baseCanvas(), {
      kind: 'connect-nodes',
      edgeId: 'e1',
      fromNode: 'a',
      toNode: 'b',
    })
    const next = applyCommand(connected, { kind: 'delete-node', id: 'a' })

    expect(next.nodes).toEqual([connected.nodes[1]])
    expect(next.edges).toEqual([])
    expect(spatialCanvasSchema.safeParse(next).success).toBe(true)
  })

  it('delete-node with a missing id returns the input canvas unchanged', () => {
    const canvas = baseCanvas()
    const next = applyCommand(canvas, { kind: 'delete-node', id: 'missing' })
    expect(next).toBe(canvas)
  })

  it('set-node-color applies a preset and undefined returns the node to the theme default', () => {
    const colored = applyCommand(baseCanvas(), { kind: 'set-node-color', id: 'a', color: '4' })
    expect(colored.nodes.find((n) => n.id === 'a')).toMatchObject({ color: '4' })
    expect(spatialCanvasSchema.safeParse(colored).success).toBe(true)

    const cleared = applyCommand(colored, { kind: 'set-node-color', id: 'a', color: undefined })
    expect(cleared.nodes.find((n) => n.id === 'a')).not.toHaveProperty('color')
    expect(spatialCanvasSchema.safeParse(cleared).success).toBe(true)
  })

  it('set-edge-color applies a preset and undefined removes it', () => {
    const connected = applyCommand(baseCanvas(), {
      kind: 'connect-nodes',
      edgeId: 'e1',
      fromNode: 'a',
      toNode: 'b',
    })
    const colored = applyCommand(connected, { kind: 'set-edge-color', id: 'e1', color: '6' })
    expect(colored.edges[0]).toMatchObject({ color: '6' })

    const cleared = applyCommand(colored, { kind: 'set-edge-color', id: 'e1', color: undefined })
    expect(cleared.edges[0]).not.toHaveProperty('color')
    expect(spatialCanvasSchema.safeParse(cleared).success).toBe(true)
  })

  it('set-edge-ends stores only non-default ends and removes fields at the spec default', () => {
    const connected = applyCommand(baseCanvas(), {
      kind: 'connect-nodes',
      edgeId: 'e1',
      fromNode: 'a',
      toNode: 'b',
    })

    const both = applyCommand(connected, {
      kind: 'set-edge-ends',
      id: 'e1',
      fromEnd: 'arrow',
      toEnd: 'arrow',
    })
    expect(both.edges[0]).toMatchObject({ fromEnd: 'arrow' })
    // toEnd 'arrow' IS the spec default — canonical form omits it.
    expect(both.edges[0]).not.toHaveProperty('toEnd')
    expect(spatialCanvasSchema.safeParse(both).success).toBe(true)

    const none = applyCommand(both, {
      kind: 'set-edge-ends',
      id: 'e1',
      fromEnd: 'none',
      toEnd: 'none',
    })
    expect(none.edges[0]).not.toHaveProperty('fromEnd')
    expect(none.edges[0]).toMatchObject({ toEnd: 'none' })

    const defaults = applyCommand(none, {
      kind: 'set-edge-ends',
      id: 'e1',
      fromEnd: 'none',
      toEnd: 'arrow',
    })
    expect(defaults.edges[0]).not.toHaveProperty('fromEnd')
    expect(defaults.edges[0]).not.toHaveProperty('toEnd')
  })

  it('set-edge-side pins one endpoint and undefined returns it to auto', () => {
    const connected = applyCommand(baseCanvas(), {
      kind: 'connect-nodes',
      edgeId: 'e1',
      fromNode: 'a',
      toNode: 'b',
    })

    const pinned = applyCommand(connected, {
      kind: 'set-edge-side',
      id: 'e1',
      endpoint: 'from',
      side: 'top',
    })
    expect(pinned.edges[0]).toMatchObject({ fromSide: 'top' })
    expect(pinned.edges[0]).not.toHaveProperty('toSide')
    expect(spatialCanvasSchema.safeParse(pinned).success).toBe(true)

    const auto = applyCommand(pinned, {
      kind: 'set-edge-side',
      id: 'e1',
      endpoint: 'from',
      side: undefined,
    })
    expect(auto.edges[0]).not.toHaveProperty('fromSide')
    expect(spatialCanvasSchema.safeParse(auto).success).toBe(true)
  })

  it('set-edge-label sets, updates, and (with an empty string) removes the label', () => {
    const connected = applyCommand(baseCanvas(), {
      kind: 'connect-nodes',
      edgeId: 'e1',
      fromNode: 'a',
      toNode: 'b',
    })

    const labeled = applyCommand(connected, { kind: 'set-edge-label', id: 'e1', label: 'yes' })
    expect(labeled.edges[0]).toMatchObject({ id: 'e1', label: 'yes' })
    expect(labeled.nodes).toBe(connected.nodes)
    expect(spatialCanvasSchema.safeParse(labeled).success).toBe(true)

    const relabeled = applyCommand(labeled, { kind: 'set-edge-label', id: 'e1', label: 'no' })
    expect(relabeled.edges[0]).toMatchObject({ id: 'e1', label: 'no' })

    const cleared = applyCommand(relabeled, { kind: 'set-edge-label', id: 'e1', label: '' })
    expect(cleared.edges[0]).not.toHaveProperty('label')
    expect(spatialCanvasSchema.safeParse(cleared).success).toBe(true)
  })

  it('set-edge-label with a missing id returns the input canvas unchanged', () => {
    const canvas = baseCanvas()
    const next = applyCommand(canvas, { kind: 'set-edge-label', id: 'missing', label: 'x' })
    expect(next).toBe(canvas)
  })

  it('set-node-url updates a link node and ignores non-link targets', () => {
    const withLink = applyCommand(baseCanvas(), {
      kind: 'create-node',
      node: {
        id: 'l1',
        type: 'link',
        x: 0,
        y: 200,
        width: 200,
        height: 60,
        url: 'https://example.com/',
      },
    })

    const updated = applyCommand(withLink, {
      kind: 'set-node-url',
      id: 'l1',
      url: 'https://jsoncanvas.org/',
    })
    expect(updated.nodes.find((n) => n.id === 'l1')).toMatchObject({
      url: 'https://jsoncanvas.org/',
    })
    expect(spatialCanvasSchema.safeParse(updated).success).toBe(true)

    // A text node has no url — the command is a no-op, not a corruption.
    const onText = applyCommand(withLink, {
      kind: 'set-node-url',
      id: 'a',
      url: 'https://example.com/',
    })
    expect(onText).toBe(withLink)

    const onMissing = applyCommand(withLink, {
      kind: 'set-node-url',
      id: 'missing',
      url: 'https://example.com/',
    })
    expect(onMissing).toBe(withLink)
  })

  it('create-group prepends the frame so members stay clickable above it', () => {
    const group = {
      id: 'g1',
      type: 'group',
      x: -20,
      y: -20,
      width: 400,
      height: 200,
      label: 'cluster',
    } as const
    const grouped = applyCommand(baseCanvas(), { kind: 'create-group', node: group })
    // Array order IS z-order: the frame sits at the bottom, so hit-testing
    // (last containing box wins) still reaches the members inside it.
    expect(grouped.nodes[0]).toMatchObject({ id: 'g1', type: 'group' })
    expect(grouped.nodes).toHaveLength(3)
    expect(spatialCanvasSchema.safeParse(grouped).success).toBe(true)

    const collided = applyCommand(grouped, { kind: 'create-group', node: group })
    expect(collided).toBe(grouped)
  })

  it('set-group-label sets, updates, empty-removes, and ignores non-groups', () => {
    const grouped = applyCommand(baseCanvas(), {
      kind: 'create-group',
      node: { id: 'g1', type: 'group', x: -20, y: -20, width: 400, height: 200 },
    })

    const labeled = applyCommand(grouped, { kind: 'set-group-label', id: 'g1', label: 'phase 1' })
    expect(labeled.nodes[0]).toMatchObject({ id: 'g1', label: 'phase 1' })
    expect(spatialCanvasSchema.safeParse(labeled).success).toBe(true)

    const cleared = applyCommand(labeled, { kind: 'set-group-label', id: 'g1', label: '' })
    expect(cleared.nodes[0]).not.toHaveProperty('label')

    const onText = applyCommand(labeled, { kind: 'set-group-label', id: 'a', label: 'x' })
    expect(onText).toBe(labeled)
  })

  it('set-node-file retargets a file node and ignores non-file targets', () => {
    const withFile = applyCommand(baseCanvas(), {
      kind: 'create-node',
      node: { id: 'f1', type: 'file', x: 0, y: 300, width: 200, height: 60, file: 'notes/plan' },
    })

    const retargeted = applyCommand(withFile, {
      kind: 'set-node-file',
      id: 'f1',
      file: 'notes/roadmap',
    })
    expect(retargeted.nodes.find((n) => n.id === 'f1')).toMatchObject({ file: 'notes/roadmap' })
    // Retargeting clears a stale subpath: a heading anchor from the old
    // document has no meaning in the new one.
    expect(retargeted.nodes.find((n) => n.id === 'f1')).not.toHaveProperty('subpath')
    expect(spatialCanvasSchema.safeParse(retargeted).success).toBe(true)

    const onText = applyCommand(withFile, { kind: 'set-node-file', id: 'a', file: 'x' })
    expect(onText).toBe(withFile)
    const onMissing = applyCommand(withFile, { kind: 'set-node-file', id: 'zzz', file: 'x' })
    expect(onMissing).toBe(withFile)
  })

  it('create then delete the same node is the identity (up to deep equality)', () => {
    const canvas = baseCanvas()
    const node = { id: 'c', type: 'text', x: 400, y: 0, width: 100, height: 50, text: '' } as const
    const created = applyCommand(canvas, { kind: 'create-node', node })
    const deleted = applyCommand(created, { kind: 'delete-node', id: node.id })
    expect(deleted).toEqual(canvas)
  })
})
