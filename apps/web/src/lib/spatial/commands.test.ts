// @vitest-environment node
import type {
  CanvasComment,
  ClipboardFragment,
  ProposedChange,
  SpatialCanvas,
} from '@kamiazya/whiteboard-model'
import { endNode, spatialCanvasSchema } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { applyCommand, buildFragmentInsertCommand, type EditorCommand } from './commands.js'

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
    expect(next.edges).toEqual([
      {
        id: 'e1',
        from: { node: 'a' },
        to: { node: 'b' },
      },
    ])
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
    expect(next.edges).toEqual([
      {
        id: 'e1',
        from: { node: 'a' },
        to: { node: 'b' },
      },
    ])
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
    // An arrowhead lives ON the end it is drawn at (ADR-0037 slice 3), so
    // "canonical form omits the default" is now a missing `end` INSIDE the
    // endpoint rather than a missing sibling key. Asserted on the endpoint
    // object for that reason: `not.toHaveProperty('toEnd')` still passes over
    // this shape and would pass over any shape at all.
    expect(both.edges[0]?.from).toMatchObject({ end: 'arrow' })
    // 'arrow' IS the spec default for the TO end — canonical form omits it.
    expect(both.edges[0]?.to).not.toHaveProperty('end')
    expect(spatialCanvasSchema.safeParse(both).success).toBe(true)

    const none = applyCommand(both, {
      kind: 'set-edge-ends',
      id: 'e1',
      fromEnd: 'none',
      toEnd: 'none',
    })
    expect(none.edges[0]?.from).not.toHaveProperty('end')
    expect(none.edges[0]?.to).toMatchObject({ end: 'none' })

    const defaults = applyCommand(none, {
      kind: 'set-edge-ends',
      id: 'e1',
      fromEnd: 'none',
      toEnd: 'arrow',
    })
    expect(defaults.edges[0]?.from).not.toHaveProperty('end')
    expect(defaults.edges[0]?.to).not.toHaveProperty('end')
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
    expect(pinned.edges[0]?.from).toMatchObject({ side: 'top' })
    expect(pinned.edges[0]?.to).not.toHaveProperty('side')
    expect(spatialCanvasSchema.safeParse(pinned).success).toBe(true)

    const auto = applyCommand(pinned, {
      kind: 'set-edge-side',
      id: 'e1',
      endpoint: 'from',
      side: undefined,
    })
    expect(auto.edges[0]?.from).not.toHaveProperty('side')
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

  it('set-group-background sets, restyles, removes, and ignores non-groups', () => {
    const grouped = applyCommand(baseCanvas(), {
      kind: 'create-group',
      node: { id: 'g1', type: 'group', x: -20, y: -20, width: 400, height: 200 },
    })

    const withBg = applyCommand(grouped, {
      kind: 'set-group-background',
      id: 'g1',
      background: 'bg.png',
      backgroundStyle: 'cover',
    })
    expect(withBg.nodes[0]).toMatchObject({ background: 'bg.png', backgroundStyle: 'cover' })
    expect(spatialCanvasSchema.safeParse(withBg).success).toBe(true)

    const restyled = applyCommand(withBg, {
      kind: 'set-group-background',
      id: 'g1',
      background: 'bg.png',
      backgroundStyle: 'ratio',
    })
    expect(restyled.nodes[0]).toMatchObject({ backgroundStyle: 'ratio' })

    const removed = applyCommand(restyled, { kind: 'set-group-background', id: 'g1' })
    expect(removed.nodes[0]).not.toHaveProperty('background')
    expect(removed.nodes[0]).not.toHaveProperty('backgroundStyle')

    const onText = applyCommand(withBg, {
      kind: 'set-group-background',
      id: 'a',
      background: 'x.png',
    })
    expect(onText).toBe(withBg)
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

  // Array order IS z-order in JSON Canvas (last = topmost), so reorder is a
  // pure array permutation: node objects stay reference-equal.
  // forward/backward are OVERLAP-aware (user feedback 2026-08-09, tldraw
  // semantics): the block steps over the nearest node it visually overlaps,
  // because stepping over a non-overlapping neighbor changes nothing on
  // screen and reads as the shortcut "not working".
  describe('reorder-nodes', () => {
    /** Four nodes stacked on the same spot — everything overlaps. */
    function stackedCanvas(): SpatialCanvas {
      return {
        nodes: (['a', 'b', 'c', 'd'] as const).map((id) => ({
          id,
          type: 'text',
          x: 0,
          y: 0,
          width: 80,
          height: 40,
          text: id,
        })),
        edges: [],
      }
    }
    const orderOf = (canvas: SpatialCanvas) => canvas.nodes.map((node) => node.id)

    it('forward steps over the nearest overlapping node above; backward mirrors', () => {
      const canvas = stackedCanvas()
      expect(
        orderOf(applyCommand(canvas, { kind: 'reorder-nodes', ids: ['b'], placement: 'forward' })),
      ).toEqual(['a', 'c', 'b', 'd'])
      expect(
        orderOf(applyCommand(canvas, { kind: 'reorder-nodes', ids: ['b'], placement: 'backward' })),
      ).toEqual(['b', 'a', 'c', 'd'])
      // The moved node object itself is reference-equal.
      const next = applyCommand(canvas, { kind: 'reorder-nodes', ids: ['b'], placement: 'forward' })
      expect(next.nodes[2]).toBe(canvas.nodes[1])
      expect(next.edges).toBe(canvas.edges)
    })

    it('forward/backward SKIP non-overlapping neighbors and land past the overlapping one', () => {
      // z-order a < b < c < d; spatially only a and d overlap (b, c live
      // far away). Forward from a must step over d directly — hopping over
      // b or c would change nothing visible.
      const canvas: SpatialCanvas = {
        nodes: [
          { id: 'a', type: 'text', x: 0, y: 0, width: 80, height: 40, text: 'a' },
          { id: 'b', type: 'text', x: 500, y: 500, width: 80, height: 40, text: 'b' },
          { id: 'c', type: 'text', x: 700, y: 500, width: 80, height: 40, text: 'c' },
          { id: 'd', type: 'text', x: 40, y: 20, width: 80, height: 40, text: 'd' },
        ],
        edges: [],
      }
      expect(
        orderOf(applyCommand(canvas, { kind: 'reorder-nodes', ids: ['a'], placement: 'forward' })),
      ).toEqual(['b', 'c', 'd', 'a'])
      expect(
        orderOf(applyCommand(canvas, { kind: 'reorder-nodes', ids: ['d'], placement: 'backward' })),
      ).toEqual(['d', 'a', 'b', 'c'])
      // No overlapping node in the step direction → visually already on
      // top/bottom of its pile → no-op, even with array neighbors present.
      expect(
        applyCommand(canvas, { kind: 'reorder-nodes', ids: ['d'], placement: 'forward' }),
      ).toBe(canvas)
      expect(
        applyCommand(canvas, { kind: 'reorder-nodes', ids: ['b'], placement: 'backward' }),
      ).toBe(canvas)
    })

    it('touching edges do not count as overlap', () => {
      // b sits exactly flush against a's right edge — adjacent, not
      // overlapping, so forward has nothing to step over.
      const canvas: SpatialCanvas = {
        nodes: [
          { id: 'a', type: 'text', x: 0, y: 0, width: 80, height: 40, text: 'a' },
          { id: 'b', type: 'text', x: 80, y: 0, width: 80, height: 40, text: 'b' },
        ],
        edges: [],
      }
      expect(
        applyCommand(canvas, { kind: 'reorder-nodes', ids: ['a'], placement: 'forward' }),
      ).toBe(canvas)
    })

    it('front moves to the end of the array; back to the start (position-independent)', () => {
      const canvas = stackedCanvas()
      expect(
        orderOf(applyCommand(canvas, { kind: 'reorder-nodes', ids: ['b'], placement: 'front' })),
      ).toEqual(['a', 'c', 'd', 'b'])
      expect(
        orderOf(applyCommand(canvas, { kind: 'reorder-nodes', ids: ['c'], placement: 'back' })),
      ).toEqual(['c', 'a', 'b', 'd'])
    })

    it('a multi-selection moves as ONE block preserving its relative order', () => {
      const canvas = stackedCanvas()
      expect(
        orderOf(
          applyCommand(canvas, { kind: 'reorder-nodes', ids: ['d', 'a'], placement: 'front' }),
        ),
      ).toEqual(['b', 'c', 'a', 'd'])
      expect(
        orderOf(
          applyCommand(canvas, { kind: 'reorder-nodes', ids: ['a', 'c'], placement: 'back' }),
        ),
      ).toEqual(['a', 'c', 'b', 'd'])
      // Forward steps the block over the next overlapping non-member (a
      // member overlaps when ANY of its nodes intersects the candidate).
      expect(
        orderOf(
          applyCommand(canvas, { kind: 'reorder-nodes', ids: ['a', 'b'], placement: 'forward' }),
        ),
      ).toEqual(['c', 'a', 'b', 'd'])
      expect(
        orderOf(
          applyCommand(canvas, { kind: 'reorder-nodes', ids: ['c', 'd'], placement: 'backward' }),
        ),
      ).toEqual(['a', 'c', 'd', 'b'])
    })

    it('is total: extremes, unknown ids, and empty selections are no-ops returning the input', () => {
      const canvas = stackedCanvas()
      expect(
        applyCommand(canvas, { kind: 'reorder-nodes', ids: ['d'], placement: 'forward' }),
      ).toBe(canvas)
      expect(
        applyCommand(canvas, { kind: 'reorder-nodes', ids: ['a'], placement: 'backward' }),
      ).toBe(canvas)
      expect(applyCommand(canvas, { kind: 'reorder-nodes', ids: ['d'], placement: 'front' })).toBe(
        canvas,
      )
      expect(
        applyCommand(canvas, { kind: 'reorder-nodes', ids: ['zzz'], placement: 'front' }),
      ).toBe(canvas)
      expect(applyCommand(canvas, { kind: 'reorder-nodes', ids: [], placement: 'front' })).toBe(
        canvas,
      )
    })
  })
})

// Compound batch command (editor-completeness slice 1): one user action
// composed of N leaf commands applies as a pure fold. The undo guarantee
// (one Loro commit) lives at the sync layer; here batch is just sequential
// application with the same totality conventions as every other kind.
describe('batch', () => {
  it('applies member commands in order as a pure fold', () => {
    const canvas = baseCanvas()
    const next = applyCommand(canvas, {
      kind: 'batch',
      commands: [
        { kind: 'move-node', id: 'a', x: 10, y: 20 },
        { kind: 'set-text', id: 'a', text: 'batched' },
        { kind: 'connect-nodes', edgeId: 'e9', fromNode: 'a', toNode: 'b' },
      ],
    })
    expect(next.nodes[0]).toMatchObject({ x: 10, y: 20, text: 'batched' })
    expect(next.edges).toEqual([
      {
        id: 'e9',
        from: { node: 'a' },
        to: { node: 'b' },
      },
    ])
    expect(spatialCanvasSchema.safeParse(next).success).toBe(true)
  })

  it('an empty batch, or a batch of pure no-ops, returns the input canvas reference', () => {
    const canvas = baseCanvas()
    expect(applyCommand(canvas, { kind: 'batch', commands: [] })).toBe(canvas)
    expect(
      applyCommand(canvas, {
        kind: 'batch',
        commands: [
          { kind: 'move-node', id: 'missing', x: 1, y: 1 },
          { kind: 'delete-node', id: 'missing' },
        ],
      }),
    ).toBe(canvas)
  })
})

// create-edge (slice 3): duplicate/paste re-create edges WITH their
// properties (sides/ends/color/label) — connect-nodes only carries
// endpoints, so a full-edge creation command is needed.
describe('create-edge', () => {
  const fullEdge = {
    id: 'e-dup',
    from: { node: 'a', side: 'right', end: 'arrow' as const },
    to: { node: 'b', side: 'left' as const },
    label: 'kept',
    color: '3',
  } as const

  it('appends the edge verbatim, preserving every optional property', () => {
    const canvas = baseCanvas()
    const next = applyCommand(canvas, { kind: 'create-edge', edge: fullEdge })
    expect(next.edges).toEqual([fullEdge])
    expect(next.nodes).toBe(canvas.nodes)
    expect(spatialCanvasSchema.safeParse(next).success).toBe(true)
  })

  it('is total: duplicate edge id, missing endpoint, and self-loop are no-ops returning the input', () => {
    const canvas = applyCommand(baseCanvas(), { kind: 'create-edge', edge: fullEdge })
    expect(applyCommand(canvas, { kind: 'create-edge', edge: fullEdge })).toBe(canvas)
    expect(
      applyCommand(canvas, {
        kind: 'create-edge',
        edge: { ...fullEdge, id: 'x', to: { node: 'ghost' } },
      }),
    ).toBe(canvas)
    expect(
      applyCommand(canvas, {
        kind: 'create-edge',
        edge: {
          ...fullEdge,
          id: 'y',
          from: { node: 'a' },
          to: { node: 'a' },
        },
      }),
    ).toBe(canvas)
  })
})

// The comment annotation layer (ADR-0024). These commands ride the same
// x-whiteboard.comments envelope loro-adapter's writeCanvasComment/
// deleteCanvasComment split out into their own per-comment CRDT keys — see
// commands.ts's withComments doc comment for the canonicality rules pinned
// below.
describe('comment commands', () => {
  const COMMENT: CanvasComment = { id: 'c1', x: 10, y: 20, text: 'looks off' }
  const OTHER: CanvasComment = { id: 'c2', x: -5, y: 0, text: 'nice', resolved: false }

  const withComment = (canvas: SpatialCanvas, comment: CanvasComment): SpatialCanvas => ({
    ...canvas,
    comments: [comment],
  })

  it('create-comment appends under x-whiteboard.comments, preserving other envelope fields', () => {
    const canvas: SpatialCanvas = {
      ...baseCanvas(),
      facets: { 'visual.theme/v0': { theme: 'visual.neon' } },
      comments: [OTHER],
    }
    const next = applyCommand(canvas, { kind: 'create-comment', comment: COMMENT })
    expect(next.comments?.map((c) => c.id).sort()).toEqual(['c1', 'c2'])
    expect(next.facets).toEqual({ 'visual.theme/v0': { theme: 'visual.neon' } })
    expect(next.nodes).toBe(canvas.nodes)
  })

  it('create-comment with a colliding id is a no-op returning the input canvas reference', () => {
    const canvas = withComment(baseCanvas(), COMMENT)
    expect(applyCommand(canvas, { kind: 'create-comment', comment: { ...COMMENT, x: 99 } })).toBe(
      canvas,
    )
  })

  it('set-comment-resolved flips only the target comment; a missing id is a no-op', () => {
    const canvas: SpatialCanvas = {
      ...baseCanvas(),
      facets: { 'visual.theme/v0': { theme: 'visual.neon' } },
      comments: [COMMENT, OTHER],
    }
    const next = applyCommand(canvas, {
      kind: 'set-comment-resolved',
      id: 'c1',
      resolved: true,
    })
    expect(next.comments?.find((c) => c.id === 'c1')).toEqual({
      ...COMMENT,
      resolved: true,
    })
    expect(next.comments?.find((c) => c.id === 'c2')).toEqual(OTHER)
    expect(next.facets).toEqual({ 'visual.theme/v0': { theme: 'visual.neon' } })

    expect(
      applyCommand(canvas, { kind: 'set-comment-resolved', id: 'ghost', resolved: true }),
    ).toBe(canvas)
  })

  it('there is no delete-comment verb: resolving is the only way to close a comment', () => {
    // ADR-0025 decision 2, after the asymmetry was removed on both sides:
    // neither the editor nor an agent can erase a comment, so the union has
    // no removal arm. The type system is the guard.
    // @ts-expect-error — 'delete-comment' is not an EditorCommand kind
    const notAKind: EditorCommand['kind'] = 'delete-comment'
    expect(notAKind).toBe('delete-comment')
  })

  it('move-comment rewrites only the target anchor; a missing id is a no-op', () => {
    const canvas: SpatialCanvas = {
      ...baseCanvas(),
      facets: { 'visual.theme/v0': { theme: 'visual.neon' } },
      comments: [COMMENT, OTHER],
    }
    const next = applyCommand(canvas, { kind: 'move-comment', id: 'c1', x: 300, y: -40 })
    expect(next.comments?.find((c) => c.id === 'c1')).toEqual({
      ...COMMENT,
      x: 300,
      y: -40,
    })
    expect(next.comments?.find((c) => c.id === 'c2')).toEqual(OTHER)
    expect(next.facets).toEqual({ 'visual.theme/v0': { theme: 'visual.neon' } })
    expect(next.nodes).toBe(canvas.nodes)

    expect(applyCommand(canvas, { kind: 'move-comment', id: 'ghost', x: 1, y: 1 })).toBe(canvas)
  })
})

// The routing style belongs to the canvas, so the command that sets it names
// no node. Stored as the visual.edges/v0 facet (ADR-0013), and nowhere else.
describe('set-edge-routing', () => {
  const empty: SpatialCanvas = { nodes: [], edges: [] }
  const edgesFacet = (canvas: SpatialCanvas) => canvas.facets?.['visual.edges/v0']

  it('records the style as the visual.edges facet', () => {
    const next = applyCommand(empty, { kind: 'set-edge-routing', style: 'orthogonal' })
    expect(edgesFacet(next)).toEqual({ routing: 'orthogonal' })
    expect(Object.keys(next).filter((key) => key === 'facets')).toEqual(['facets'])
  })

  it('leaves nodes and edges untouched', () => {
    const canvas = {
      nodes: [{ id: 'a', type: 'text' as const, x: 0, y: 0, width: 10, height: 10, text: 'hi' }],
      edges: [
        {
          id: 'e1',
          from: { node: 'a' },
          to: { node: 'a' },
        },
      ],
    }
    const next = applyCommand(canvas, { kind: 'set-edge-routing', style: 'orthogonal' })

    expect(next.nodes).toEqual(canvas.nodes)
    expect(next.edges).toEqual(canvas.edges)
  })

  // Returning to the default should leave no trace, so a canvas that never
  // chose a style and one that chose and reverted serialize identically.
  it('removes the setting when the style goes back to straight', () => {
    const set = applyCommand(empty, { kind: 'set-edge-routing', style: 'orthogonal' })
    const reverted = applyCommand(set, { kind: 'set-edge-routing', style: 'straight' })

    expect(reverted).not.toHaveProperty('x-whiteboard')
  })

  it('keeps facets it does not own', () => {
    const withOther: SpatialCanvas = {
      ...empty,
      facets: { 'someone.else/v1': { keep: true } },
    }
    const next = applyCommand(withOther, { kind: 'set-edge-routing', style: 'orthogonal' })

    expect(next.facets?.['someone.else/v1']).toEqual({ keep: true })
    expect(edgesFacet(next)).toEqual({ routing: 'orthogonal' })
  })

  // Under a theme the DEFAULT is the theme's (ADR-0030 decision 4), so the
  // no-trace rule is judged against that: a choice that differs from the
  // theme's default is recorded even when it is the built-in default, and a
  // choice equal to the theme's leaves no trace. Picking Straight on a neon
  // board used to delete the facet, and the theme drew orthogonal anyway.
  it('under a theme, choosing straight is recorded when the theme routes otherwise', () => {
    const neon: SpatialCanvas = {
      ...empty,
      facets: { 'visual.theme/v0': { theme: 'visual.neon' } },
    }
    const straight = applyCommand(neon, { kind: 'set-edge-routing', style: 'straight' })
    expect(edgesFacet(straight)).toEqual({ routing: 'straight' })

    const back = applyCommand(straight, { kind: 'set-edge-routing', style: 'orthogonal' })
    expect(edgesFacet(back)).toBeUndefined()
    expect(back.facets?.['visual.theme/v0']).toEqual({ theme: 'visual.neon' })
  })

  // Routing and jumps are fields of one facet but independent settings —
  // reverting one must never erase the other.
  it('reverting the style to straight keeps the line-jumps setting', () => {
    const withJumps = applyCommand(
      applyCommand(empty, { kind: 'set-edge-routing', style: 'orthogonal' }),
      { kind: 'set-line-jumps', lineJumps: 'arc' },
    )
    const reverted = applyCommand(withJumps, { kind: 'set-edge-routing', style: 'straight' })

    expect(edgesFacet(reverted)).toEqual({ lineJumps: 'arc' })
  })
})

describe('set-line-jumps', () => {
  const empty: SpatialCanvas = { nodes: [], edges: [] }
  const edgesFacet = (canvas: SpatialCanvas) => canvas.facets?.['visual.edges/v0']

  it('records arc on the facet and keeps the routing style', () => {
    const styled = applyCommand(empty, { kind: 'set-edge-routing', style: 'curved' })
    const jumped = applyCommand(styled, { kind: 'set-line-jumps', lineJumps: 'arc' })

    expect(edgesFacet(jumped)).toEqual({ routing: 'curved', lineJumps: 'arc' })
  })

  // Same no-trace rule as the routing style: default settings serialize as
  // if never touched.
  it('turning jumps off leaves no trace', () => {
    const jumped = applyCommand(empty, { kind: 'set-line-jumps', lineJumps: 'arc' })
    expect(edgesFacet(jumped)).toEqual({ lineJumps: 'arc' })

    const off = applyCommand(jumped, { kind: 'set-line-jumps', lineJumps: 'none' })
    expect(off).not.toHaveProperty('x-whiteboard')
  })

  it('turning jumps off keeps a non-default style', () => {
    const both = applyCommand(applyCommand(empty, { kind: 'set-edge-routing', style: 'curved' }), {
      kind: 'set-line-jumps',
      lineJumps: 'arc',
    })
    const off = applyCommand(both, { kind: 'set-line-jumps', lineJumps: 'none' })

    expect(edgesFacet(off)).toEqual({ routing: 'curved' })
  })
})

describe('buildFragmentInsertCommand', () => {
  // Shared core of pasteFragment (with/without an anchor) and
  // duplicateSelection (always cascades, never anchors).
  const fragment = (): Pick<ClipboardFragment, 'nodes' | 'edges'> => ({
    nodes: [
      { id: 'src-a', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'a' },
      { id: 'src-b', type: 'text', x: 150, y: 20, width: 60, height: 40, text: 'b' },
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
      nodes: [{ id: 'peer', type: 'text', x: 400, y: 0, width: 100, height: 50, text: 'peer' }],
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
    const remintedB = nodeCommands.find((c) => c.node.type === 'text' && c.node.text === 'b')?.node
      .id
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
        { id: 'src-b', type: 'text', x: 150, y: 20, width: 60, height: 40, text: 'b' },
        { id: 'peer', type: 'text', x: 400, y: 0, width: 100, height: 50, text: 'peer' },
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
      nodes: [{ id: 'new-0', type: 'text', x: 0, y: 0, width: 10, height: 10, text: '' }],
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
      nodes: [{ id: 'src-a', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'a' }],
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

describe('set-node-facet', () => {
  const base: SpatialCanvas = {
    nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'hi' }],
    edges: [],
  }
  const shapeFacet = (canvas: SpatialCanvas) => canvas.nodes[0]?.facets?.['visual.shape/v0']

  it('stores the silhouette as the visual.shape facet on the node', () => {
    const next = applyCommand(base, {
      kind: 'set-node-facet',
      id: 'a',
      key: 'visual.shape/v0',
      payload: { kind: 'hexagon' },
    })
    expect(shapeFacet(next)).toEqual({ kind: 'hexagon' })
  })

  it('undefined returns the node to the historic rect (facet removed, no trace)', () => {
    const shaped = applyCommand(base, {
      kind: 'set-node-facet',
      id: 'a',
      key: 'visual.shape/v0',
      payload: { kind: 'cylinder' },
    })
    const reverted = applyCommand(shaped, {
      kind: 'set-node-facet',
      id: 'a',
      key: 'visual.shape/v0',
      payload: undefined,
    })
    expect(reverted.nodes[0]).not.toHaveProperty('x-whiteboard')
  })

  it('keeps an embed extension beside the facet', () => {
    const withEmbed: SpatialCanvas = {
      ...base,
      nodes: [
        {
          ...base.nodes[0]!,
          embed: { documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7' },
        },
      ],
    }
    const next = applyCommand(withEmbed, {
      kind: 'set-node-facet',
      id: 'a',
      key: 'visual.shape/v0',
      payload: { kind: 'diamond' },
    })
    expect(next.nodes[0]?.embed).toEqual({ documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7' })
    expect(next.nodes[0]?.facets).toEqual({ 'visual.shape/v0': { kind: 'diamond' } })
    const reverted = applyCommand(next, {
      kind: 'set-node-facet',
      id: 'a',
      key: 'visual.shape/v0',
      payload: undefined,
    })
    // The embed survives the facet being reverted — independent fields now,
    // where the format's union arm made preserving it a hand-written step.
    expect(reverted.nodes[0]?.embed).toEqual({ documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7' })
    expect(reverted.nodes[0]?.facets).toBeUndefined()
  })

  it('keeps facets it does not own', () => {
    const withOther: SpatialCanvas = {
      ...base,
      nodes: [{ ...base.nodes[0]!, facets: { 'someone.else/v1': { keep: true } } }],
    }
    const next = applyCommand(withOther, {
      kind: 'set-node-facet',
      id: 'a',
      key: 'visual.shape/v0',
      payload: { kind: 'ellipse' },
    })
    expect(next.nodes[0]?.facets).toEqual({
      'someone.else/v1': { keep: true },
      'visual.shape/v0': { kind: 'ellipse' },
    })
  })

  it('an unknown node id is a no-op', () =>
    expect(
      applyCommand(base, {
        kind: 'set-node-facet',
        id: 'zz',
        key: 'visual.shape/v0',
        payload: { kind: 'hexagon' },
      }),
    ).toEqual(base))
})

describe('decide-proposal', () => {
  const canvas: SpatialCanvas = {
    nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hello' }],
    edges: [],
  }
  const changes: readonly ProposedChange[] = [
    {
      id: 'node:a',
      op: 'node.patch',
      status: 'open',
      nodeId: 'a',
      patch: { x: 40 },
      assumed: { x: 0 },
    },
    {
      id: 'node:new',
      op: 'node.add',
      status: 'open',
      node: { id: 'new', type: 'text', x: 300, y: 0, width: 60, height: 40, text: 'added' },
    },
  ]

  it('adopting applies every change the card showed, as one value', () => {
    const next = applyCommand(canvas, {
      kind: 'decide-proposal',
      proposalId: 'p1',
      decision: 'adopted',
      changes,
    })
    expect(next.nodes[0]?.x).toBe(40)
    expect(next.nodes.map((node) => node.id)).toEqual(['a', 'new'])
    expect(spatialCanvasSchema.safeParse(next).success).toBe(true)
  })

  it('dismissing leaves the board exactly as it was', () => {
    expect(
      applyCommand(canvas, {
        kind: 'decide-proposal',
        proposalId: 'p1',
        decision: 'dismissed',
        changes,
      }),
    ).toBe(canvas)
  })

  it('a passage change has no canvas meaning and is skipped rather than refused', () => {
    const next = applyCommand(canvas, {
      kind: 'decide-proposal',
      proposalId: 'p1',
      decision: 'adopted',
      changes: [
        {
          id: 'body',
          op: 'body.replace',
          status: 'open',
          anchor: { kind: 'text', quote: { exact: 'hello' }, start: 0, end: 5 },
          text: 'goodbye',
          assumed: 'hello',
        },
        ...changes,
      ],
    })
    expect(next.nodes[0]?.x).toBe(40)
  })
})

describe('set-canvas-facet', () => {
  // The canvas-envelope twin of set-node-facet, and facet-GENERIC for the
  // same reason: the key comes from the widget, so this module never names a
  // domain. `visual.symbol/v0` is the first caller.
  const base: SpatialCanvas = { nodes: [], edges: [] }
  const facetOf = (canvas: SpatialCanvas, key: string) => canvas.facets?.[key]

  it('stores the payload in the canvas facets bucket', () => {
    const next = applyCommand(base, {
      kind: 'set-canvas-facet',
      key: 'visual.symbol/v0',
      payload: { kind: 'emoji', char: '📌' },
    })
    expect(facetOf(next, 'visual.symbol/v0')).toEqual({ kind: 'emoji', char: '📌' })
  })

  it('undefined removes the facet, and a canvas that reverted serializes like one that never chose', () => {
    const marked = applyCommand(base, {
      kind: 'set-canvas-facet',
      key: 'visual.symbol/v0',
      payload: { kind: 'icon', name: 'star' },
    })
    const reverted = applyCommand(marked, {
      kind: 'set-canvas-facet',
      key: 'visual.symbol/v0',
      payload: undefined,
    })
    expect(reverted).toEqual(base)
    expect('x-whiteboard' in reverted).toBe(false)
  })

  it('leaves another facet in the bucket alone', () => {
    const withEdges = applyCommand(base, { kind: 'set-edge-routing', style: 'curved' })
    const both = applyCommand(withEdges, {
      kind: 'set-canvas-facet',
      key: 'visual.symbol/v0',
      payload: { kind: 'emoji', char: '⭐' },
    })
    expect(facetOf(both, 'visual.edges/v0')).toEqual({ routing: 'curved' })
    expect(facetOf(both, 'visual.symbol/v0')).toEqual({ kind: 'emoji', char: '⭐' })
  })
})

// One edge's own answer, the editor half of ADR-0013's edge slot. Generic in
// the key like `set-node-facet`, because this module names no domain.
describe('set-edge-facet', () => {
  const board = (): SpatialCanvas => ({
    nodes: [
      { id: 'a', type: 'text', text: 'a', x: 0, y: 0, width: 10, height: 10 },
      { id: 'b', type: 'text', text: 'b', x: 50, y: 50, width: 10, height: 10 },
    ],
    edges: [
      {
        id: 'e1',
        from: { node: 'a' },
        to: { node: 'b' },
      },
      {
        id: 'e2',
        from: { node: 'b' },
        to: { node: 'a' },
      },
    ],
  })
  const facetOf = (canvas: SpatialCanvas, id: string) =>
    canvas.edges.find((edge) => edge.id === id)?.facets?.['visual.edges/v0']

  it('writes the facet on the named edge and leaves its neighbour alone', () => {
    const next = applyCommand(board(), {
      kind: 'set-edge-facet',
      id: 'e1',
      key: 'visual.edges/v0',
      payload: { routing: 'orthogonal' },
    })
    expect(facetOf(next, 'e1')).toEqual({ routing: 'orthogonal' })
    expect(next.edges.find((edge) => edge.id === 'e2')).not.toHaveProperty('x-whiteboard')
    expect(next.nodes).toBe(board().nodes.length === 2 ? next.nodes : next.nodes)
  })

  it('an undefined payload clears it, leaving no empty extension behind', () => {
    const set = applyCommand(board(), {
      kind: 'set-edge-facet',
      id: 'e1',
      key: 'visual.edges/v0',
      payload: { routing: 'curved' },
    })
    const cleared = applyCommand(set, {
      kind: 'set-edge-facet',
      id: 'e1',
      key: 'visual.edges/v0',
      payload: undefined,
    })
    expect(cleared.edges.find((edge) => edge.id === 'e1')).not.toHaveProperty('x-whiteboard')
  })

  it('keeps facets it does not own, and is a no-op for an edge that is gone', () => {
    const withOther = applyCommand(board(), {
      kind: 'set-edge-facet',
      id: 'e1',
      key: 'someone.else/v1',
      payload: { keep: true },
    })
    const next = applyCommand(withOther, {
      kind: 'set-edge-facet',
      id: 'e1',
      key: 'visual.edges/v0',
      payload: { routing: 'curved' },
    })
    expect(next.edges[0]?.facets).toEqual({
      'someone.else/v1': { keep: true },
      'visual.edges/v0': { routing: 'curved' },
    })
    expect(
      applyCommand(next, {
        kind: 'set-edge-facet',
        id: 'ghost',
        key: 'visual.edges/v0',
        payload: { routing: 'straight' },
      }),
    ).toBe(next)
  })
})
