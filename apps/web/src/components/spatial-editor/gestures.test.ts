import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { describe, expect, it } from 'vitest'
import { createIdleState, reduceGesture } from './gestures.js'

function canvas(): SpatialCanvas {
  return {
    nodes: [{ id: 'a', type: 'text', x: 10, y: 10, width: 100, height: 50, text: 'hi' }],
    edges: [],
  }
}

describe('gesture reducer', () => {
  it('a zero-delta drag emits a select, not a move-node command', () => {
    const c = canvas()
    const down = reduceGesture(createIdleState(), c, {
      type: 'pointerdown',
      nodeId: 'a',
      point: { x: 50, y: 30 },
    })
    expect(down.selectedId).toBe('a')
    const up = reduceGesture(down.state, c, { type: 'pointerup', point: { x: 50, y: 30 } })
    expect(up.state.kind).toBe('idle')
    expect(up.commands).toEqual([])
  })

  it('a drag on a selected node commits a move-node with the delta applied', () => {
    const c = canvas()
    let result = reduceGesture(createIdleState(), c, {
      type: 'pointerdown',
      nodeId: 'a',
      point: { x: 50, y: 30 },
    })
    result = reduceGesture(result.state, c, {
      type: 'pointermove',
      point: { x: 70, y: 45 },
    })
    result = reduceGesture(result.state, c, { type: 'pointerup', point: { x: 70, y: 45 } })
    expect(result.commands).toEqual([{ kind: 'move-node', id: 'a', x: 30, y: 25 }])
    expect(result.state.kind).toBe('idle')
  })

  it('pointercancel always returns to idle with no command', () => {
    const c = canvas()
    let result = reduceGesture(createIdleState(), c, {
      type: 'pointerdown',
      nodeId: 'a',
      point: { x: 50, y: 30 },
    })
    result = reduceGesture(result.state, c, { type: 'pointermove', point: { x: 90, y: 90 } })
    result = reduceGesture(result.state, c, { type: 'pointercancel' })
    expect(result.state.kind).toBe('idle')
    expect(result.commands).toEqual([])
  })

  it('aborts cleanly when the target node vanishes mid-drag (canvas-replaced)', () => {
    const c = canvas()
    let result = reduceGesture(createIdleState(), c, {
      type: 'pointerdown',
      nodeId: 'a',
      point: { x: 50, y: 30 },
    })
    const replaced: SpatialCanvas = { nodes: [], edges: [] }
    result = reduceGesture(result.state, c, { type: 'canvas-replaced', canvas: replaced })
    expect(result.state.kind).toBe('idle')
    expect(result.commands).toEqual([])
  })

  it('an externally-originated canvas-replaced (e.g. undo) cancels an in-flight move even when the target node still exists unchanged', () => {
    const c = canvas()
    let result = reduceGesture(createIdleState(), c, {
      type: 'pointerdown',
      nodeId: 'a',
      point: { x: 50, y: 30 },
    })
    result = reduceGesture(result.state, c, { type: 'pointermove', point: { x: 70, y: 45 } })
    // Same canvas contents as the start snapshot (the undo shape: node still
    // exists, coordinates reverted) — targetsStillValid would say "continue",
    // but an external replacement must cancel regardless.
    result = reduceGesture(result.state, c, {
      type: 'canvas-replaced',
      canvas: c,
      origin: 'external',
    })
    expect(result.state.kind).toBe('idle')
    expect(result.commands).toEqual([])
  })

  it('a locally-originated canvas-replaced leaves a valid in-flight move gesture unaffected', () => {
    const c = canvas()
    let result = reduceGesture(createIdleState(), c, {
      type: 'pointerdown',
      nodeId: 'a',
      point: { x: 50, y: 30 },
    })
    result = reduceGesture(result.state, c, { type: 'pointermove', point: { x: 70, y: 45 } })
    result = reduceGesture(result.state, c, {
      type: 'canvas-replaced',
      canvas: c,
      origin: 'local',
    })
    expect(result.state.kind).toBe('moving')
    result = reduceGesture(result.state, c, { type: 'pointerup', point: { x: 70, y: 45 } })
    expect(result.commands).toEqual([{ kind: 'move-node', id: 'a', x: 30, y: 25 }])
  })

  it('aborts cleanly when the target node type changes mid-drag', () => {
    const c = canvas()
    let result = reduceGesture(createIdleState(), c, {
      type: 'pointerdown',
      nodeId: 'a',
      point: { x: 50, y: 30 },
    })
    const replaced: SpatialCanvas = {
      nodes: [{ id: 'a', type: 'file', x: 10, y: 10, width: 100, height: 50, file: 'x.png' }],
      edges: [],
    }
    result = reduceGesture(result.state, c, { type: 'canvas-replaced', canvas: replaced })
    expect(result.state.kind).toBe('idle')
    expect(result.commands).toEqual([])
  })

  it('commits from the gesture start snapshot when the node moved remotely mid-drag', () => {
    const c = canvas()
    let result = reduceGesture(createIdleState(), c, {
      type: 'pointerdown',
      nodeId: 'a',
      point: { x: 50, y: 30 },
    })
    result = reduceGesture(result.state, c, { type: 'pointermove', point: { x: 70, y: 45 } })
    const remote: SpatialCanvas = {
      nodes: [{ id: 'a', type: 'text', x: 999, y: 999, width: 100, height: 50, text: 'hi' }],
      edges: [],
    }
    result = reduceGesture(result.state, remote, { type: 'canvas-replaced', canvas: remote })
    result = reduceGesture(result.state, remote, { type: 'pointerup', point: { x: 70, y: 45 } })
    // start node was at (10, 10); delta is (20, 15) -> commits 30, 25, NOT 999-based
    expect(result.commands).toEqual([{ kind: 'move-node', id: 'a', x: 30, y: 25 }])
  })

  it('pointerdown on a missing node id is a no-op (no selection, stays idle)', () => {
    const c = canvas()
    const result = reduceGesture(createIdleState(), c, {
      type: 'pointerdown',
      nodeId: 'missing',
      point: { x: 50, y: 30 },
    })
    expect(result.state.kind).toBe('idle')
    expect(result.selectedId).toBeUndefined()
    expect(result.commands).toEqual([])
  })

  it('is total over arbitrary pointerup/pointercancel without a prior pointerdown', () => {
    const c = canvas()
    const state = createIdleState()
    expect(() =>
      reduceGesture(state, c, { type: 'pointerup', point: { x: 0, y: 0 } }),
    ).not.toThrow()
    expect(() => reduceGesture(state, c, { type: 'pointercancel' })).not.toThrow()
  })
})

describe('resize gesture', () => {
  it('dragging the se (max-side) handle grows width/height, opposite corner fixed', () => {
    const c = canvas()
    let result = reduceGesture(createIdleState(), c, {
      type: 'pointerdown-handle',
      nodeId: 'a',
      handle: 'se',
      point: { x: 110, y: 60 },
      box: { x: 10, y: 10, width: 100, height: 50 },
    })
    result = reduceGesture(result.state, c, {
      type: 'pointerup',
      point: { x: 130, y: 90 },
    })
    // se: width/height grow by the delta, x/y (the nw corner) stay fixed.
    expect(result.commands).toEqual([
      {
        kind: 'resize-node',
        id: 'a',
        x: 10,
        y: 10,
        width: 120,
        height: 80,
      },
    ])
    expect(result.state.kind).toBe('idle')
  })

  it('dragging the nw (min-side) handle shrinks the box and shifts x/y, opposite corner fixed', () => {
    const c = canvas()
    let result = reduceGesture(createIdleState(), c, {
      type: 'pointerdown-handle',
      nodeId: 'a',
      handle: 'nw',
      point: { x: 10, y: 10 },
      box: { x: 10, y: 10, width: 100, height: 50 },
    })
    result = reduceGesture(result.state, c, {
      type: 'pointerup',
      point: { x: 30, y: 20 },
    })
    // nw: dragging inward shrinks width/height and moves x/y by the same
    // delta, so the se corner (x + width, y + height) stays fixed at (110, 60).
    expect(result.commands).toEqual([
      {
        kind: 'resize-node',
        id: 'a',
        x: 30,
        y: 20,
        width: 80,
        height: 40,
      },
    ])
    expect(result.state.kind).toBe('idle')
  })

  it('a zero-delta resize handle drag emits no command', () => {
    const c = canvas()
    let result = reduceGesture(createIdleState(), c, {
      type: 'pointerdown-handle',
      nodeId: 'a',
      handle: 'se',
      point: { x: 110, y: 60 },
      box: { x: 10, y: 10, width: 100, height: 50 },
    })
    result = reduceGesture(result.state, c, {
      type: 'pointerup',
      point: { x: 110, y: 60 },
    })
    expect(result.commands).toEqual([])
    expect(result.state.kind).toBe('idle')
  })

  it('overshooting a min-side handle past the box floor-clamps size and keeps the opposite corner fixed', () => {
    const c = canvas()
    let result = reduceGesture(createIdleState(), c, {
      type: 'pointerdown-handle',
      nodeId: 'a',
      handle: 'nw',
      point: { x: 10, y: 10 },
      box: { x: 10, y: 10, width: 100, height: 50 },
    })
    // Drag the nw handle 200px right/down — far past the box's own 100x50
    // size. Naively unclamped, x/y would land at 210/210, dragging the
    // opposite (se) corner along with it instead of leaving it fixed.
    result = reduceGesture(result.state, c, {
      type: 'pointerup',
      point: { x: 210, y: 210 },
    })
    expect(result.commands).toEqual([
      {
        kind: 'resize-node',
        id: 'a',
        x: 110,
        y: 60,
        width: 0,
        height: 0,
      },
    ])
    expect(result.state.kind).toBe('idle')
  })
})

describe('resize handle miss', () => {
  it('pointerdown-handle on a missing node id is a no-op', () => {
    const c = canvas()
    const result = reduceGesture(createIdleState(), c, {
      type: 'pointerdown-handle',
      nodeId: 'missing',
      handle: 'se',
      point: { x: 10, y: 10 },
      box: { x: 10, y: 10, width: 100, height: 50 },
    })
    expect(result.state.kind).toBe('idle')
    expect(result.commands).toEqual([])
  })
})

describe('connect gesture', () => {
  it('dragging from the connect handle onto another node emits connect-nodes', () => {
    const c: SpatialCanvas = {
      nodes: [
        { id: 'a', type: 'text', x: 10, y: 10, width: 100, height: 50, text: 'hi' },
        { id: 'b', type: 'text', x: 200, y: 10, width: 100, height: 50, text: 'bye' },
      ],
      edges: [],
    }
    let result = reduceGesture(createIdleState(), c, {
      type: 'pointerdown-connect',
      nodeId: 'a',
    })
    expect(result.state).toEqual({ kind: 'connecting', fromNodeId: 'a' })
    result = reduceGesture(
      result.state,
      c,
      { type: 'pointerup', point: { x: 250, y: 30 }, targetNodeId: 'b' },
      { createId: () => 'edge-1' },
    )
    expect(result.commands).toEqual([
      {
        kind: 'connect-nodes',
        edgeId: 'edge-1',
        fromNode: 'a',
        toNode: 'b',
      },
    ])
    expect(result.state.kind).toBe('idle')
  })

  it('dropping a connect drag with no target under the pointer emits no command', () => {
    const c = canvas()
    let result = reduceGesture(createIdleState(), c, {
      type: 'pointerdown-connect',
      nodeId: 'a',
    })
    result = reduceGesture(result.state, c, { type: 'pointerup', point: { x: 500, y: 500 } })
    expect(result.commands).toEqual([])
    expect(result.state.kind).toBe('idle')
  })

  it('releasing over the source node creates no edge and KEEPS the connect armed (click-A-click-B)', () => {
    // Self-connection stays guarded (no command), but the state survives:
    // the object-first Connect tool's first click presses AND releases on
    // the source node, so an idle reset here would make click-click
    // connecting impossible. Cancel is releasing over empty space.
    const c = canvas()
    let result = reduceGesture(createIdleState(), c, {
      type: 'pointerdown-connect',
      nodeId: 'a',
    })
    result = reduceGesture(result.state, c, {
      type: 'pointerup',
      point: { x: 50, y: 30 },
      targetNodeId: 'a',
    })
    expect(result.commands).toEqual([])
    expect(result.state.kind).toBe('connecting')
  })
})

describe('text-edit gesture', () => {
  it('start-text-edit enters editing-text state for the given node', () => {
    const c = canvas()
    const result = reduceGesture(createIdleState(), c, {
      type: 'start-text-edit',
      nodeId: 'a',
      text: 'hi',
    })
    expect(result.state).toEqual({ kind: 'editing-text', nodeId: 'a', pendingText: 'hi' })
    expect(result.commands).toEqual([])
  })

  it('commit-text-edit emits set-text and returns to idle', () => {
    const c = canvas()
    const editing = reduceGesture(createIdleState(), c, {
      type: 'start-text-edit',
      nodeId: 'a',
      text: 'hi',
    })
    const result = reduceGesture(editing.state, c, {
      type: 'commit-text-edit',
      text: 'updated',
    })
    expect(result.commands).toEqual([{ kind: 'set-text', id: 'a', text: 'updated' }])
    expect(result.state.kind).toBe('idle')
  })

  it('a pointerdown on a different node while a text edit is open commits the pending text', () => {
    const c: SpatialCanvas = {
      nodes: [
        { id: 'a', type: 'text', x: 10, y: 10, width: 100, height: 50, text: 'hi' },
        { id: 'b', type: 'text', x: 200, y: 10, width: 100, height: 50, text: 'bye' },
      ],
      edges: [],
    }
    const editing = reduceGesture(createIdleState(), c, {
      type: 'start-text-edit',
      nodeId: 'a',
      text: 'hi',
    })
    const updated = reduceGesture(editing.state, c, { type: 'update-text-edit', text: 'edited' })
    const result = reduceGesture(updated.state, c, {
      type: 'pointerdown',
      nodeId: 'b',
      point: { x: 250, y: 30 },
    })
    expect(result.commands).toEqual([{ kind: 'set-text', id: 'a', text: 'edited' }])
    expect(result.state.kind).toBe('moving')
    expect(result.selectedId).toBe('b')
  })

  it('a pointerdown on empty canvas while a text edit is open commits the pending text (click-away commits)', () => {
    const c = canvas()
    const editing = reduceGesture(createIdleState(), c, {
      type: 'start-text-edit',
      nodeId: 'a',
      text: 'hi',
    })
    const updated = reduceGesture(editing.state, c, { type: 'update-text-edit', text: 'edited' })
    const result = reduceGesture(updated.state, c, { type: 'pointerdown-empty' })
    expect(result.commands).toEqual([{ kind: 'set-text', id: 'a', text: 'edited' }])
    expect(result.state.kind).toBe('idle')
    expect(result.selectedId).toBeNull()
  })

  it('pointerdown-empty outside a text edit emits no command', () => {
    const c = canvas()
    const result = reduceGesture(createIdleState(), c, { type: 'pointerdown-empty' })
    expect(result.commands).toEqual([])
    expect(result.selectedId).toBeNull()
  })

  it('commit-text-edit outside editing-text state is a no-op', () => {
    const c = canvas()
    const result = reduceGesture(createIdleState(), c, {
      type: 'commit-text-edit',
      text: 'updated',
    })
    expect(result.commands).toEqual([])
    expect(result.state.kind).toBe('idle')
  })

  it('cancel-text-edit discards the edit and returns to idle with no command', () => {
    const c = canvas()
    const editing = reduceGesture(createIdleState(), c, {
      type: 'start-text-edit',
      nodeId: 'a',
      text: 'hi',
    })
    const result = reduceGesture(editing.state, c, { type: 'cancel-text-edit' })
    expect(result.state.kind).toBe('idle')
    expect(result.commands).toEqual([])
  })

  it('an externally-originated canvas-replaced closes an open text edit without committing its pending text', () => {
    const c = canvas()
    const editing = reduceGesture(createIdleState(), c, {
      type: 'start-text-edit',
      nodeId: 'a',
      text: 'hi',
    })
    const updated = reduceGesture(editing.state, c, { type: 'update-text-edit', text: 'edited' })
    const result = reduceGesture(updated.state, c, {
      type: 'canvas-replaced',
      canvas: c,
      origin: 'external',
    })
    expect(result.state.kind).toBe('idle')
    expect(result.commands).toEqual([])
  })

  it('aborts an in-flight text edit when the node type changes mid-edit (canvas-replaced)', () => {
    const c = canvas()
    const editing = reduceGesture(createIdleState(), c, {
      type: 'start-text-edit',
      nodeId: 'a',
      text: 'hi',
    })
    const replaced: SpatialCanvas = {
      nodes: [{ id: 'a', type: 'file', x: 10, y: 10, width: 100, height: 50, file: 'x.png' }],
      edges: [],
    }
    const result = reduceGesture(editing.state, c, { type: 'canvas-replaced', canvas: replaced })
    expect(result.state.kind).toBe('idle')
    expect(result.commands).toEqual([])
  })
})

describe('create-closed-node (the rectangle path)', () => {
  it('creates the same node dblclick-empty does, selects it, and opens NO editor', () => {
    const c = canvas()
    const result = reduceGesture(
      createIdleState(),
      c,
      { type: 'create-closed-node', point: { x: 300, y: 200 } },
      { createId: () => 'new-node' },
    )
    expect(result.commands).toEqual([
      {
        kind: 'create-node',
        node: { id: 'new-node', type: 'text', text: '', x: 200, y: 150, width: 200, height: 100 },
      },
    ])
    // Selecting it is what gives the new rectangle its handles: without this
    // it lands on the canvas with nothing to grab, move or delete it by.
    expect(result.selectedId).toBe('new-node')
    // The whole difference from a note. `editing-text` here would open the
    // editor on a shape nobody asked to type into.
    expect(result.state).toEqual({ kind: 'idle' })
  })
})

describe('dblclick-empty (create-node)', () => {
  it('creates a text node centered on the point, selects it, and opens it for typing immediately', () => {
    const c = canvas()
    const result = reduceGesture(
      createIdleState(),
      c,
      { type: 'dblclick-empty', point: { x: 300, y: 200 } },
      { createId: () => 'new-node' },
    )
    expect(result.commands[0]).toMatchObject({
      kind: 'create-node',
      node: { id: 'new-node', type: 'text', text: '' },
    })
    expect(result.selectedId).toBe('new-node')
    expect(result.state).toEqual({
      kind: 'editing-text',
      nodeId: 'new-node',
      pendingText: '',
      // The node exists only for this edit — cancelling takes it with it.
      createdForEdit: true,
    })
  })

  it('while a text edit is open, first commits the pending text, then creates the new node', () => {
    const c = canvas()
    const editing = reduceGesture(createIdleState(), c, {
      type: 'start-text-edit',
      nodeId: 'a',
      text: 'hi',
    })
    const updated = reduceGesture(editing.state, c, { type: 'update-text-edit', text: 'edited' })
    const result = reduceGesture(
      updated.state,
      c,
      { type: 'dblclick-empty', point: { x: 300, y: 200 } },
      { createId: () => 'new-node' },
    )
    // withPendingTextCommit prepends the pending set-text ahead of the
    // event's own commands (ordered commit-then-create) — neither command is
    // dropped, and the old node's text is never lost.
    expect(result.commands).toEqual([
      { kind: 'set-text', id: 'a', text: 'edited' },
      { kind: 'create-node', node: expect.objectContaining({ id: 'new-node', text: '' }) },
    ])
    expect(result.state).toEqual({
      kind: 'editing-text',
      nodeId: 'new-node',
      pendingText: '',
      // The node exists only for this edit — cancelling takes it with it.
      createdForEdit: true,
    })
  })
})

describe('delete-selection', () => {
  it('emits delete-node and clears selection while idle', () => {
    const c = canvas()
    const result = reduceGesture(createIdleState(), c, {
      type: 'delete-selection',
      nodeId: 'a',
    })
    expect(result.commands).toEqual([{ kind: 'delete-node', id: 'a' }])
    expect(result.selectedId).toBeNull()
    expect(result.state.kind).toBe('idle')
  })

  it('emits NO command while a text edit is open, leaving state untouched (Backspace must not delete while typing)', () => {
    const c = canvas()
    const editing = reduceGesture(createIdleState(), c, {
      type: 'start-text-edit',
      nodeId: 'a',
      text: 'hi',
    })
    const result = reduceGesture(editing.state, c, { type: 'delete-selection', nodeId: 'a' })
    expect(result.commands).toEqual([])
    expect(result.state).toEqual(editing.state)
    expect(result.selectedId).toBeUndefined()
  })
})

// Handles drawn around a whole selection have to mean what handles around one
// node mean: the group resizes as a single object and the arrangement inside
// it survives.
describe('multi-selection resize', () => {
  function pair(): SpatialCanvas {
    return {
      nodes: [
        { id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 100, text: 'a' },
        { id: 'b', type: 'text', x: 200, y: 0, width: 100, height: 100, text: 'b' },
      ],
      edges: [],
    }
  }
  const ENCLOSING = { x: 0, y: 0, width: 300, height: 100 }
  const MEMBERS = [
    { id: 'a', box: { x: 0, y: 0, width: 100, height: 100 } },
    { id: 'b', box: { x: 200, y: 0, width: 100, height: 100 } },
  ]

  function dragSouthEastBy(dx: number, dy: number) {
    const c = pair()
    const down = reduceGesture(createIdleState(), c, {
      type: 'pointerdown-handle',
      nodeId: 'a',
      handle: 'se',
      point: { x: 300, y: 100 },
      box: ENCLOSING,
      members: MEMBERS,
    })
    return reduceGesture(down.state, c, {
      type: 'pointerup',
      point: { x: 300 + dx, y: 100 + dy },
    })
  }

  it('commits one resize per member, scaled by the same factors', () => {
    // 300 -> 600 wide, height unchanged.
    expect(dragSouthEastBy(300, 0).commands).toEqual([
      { kind: 'resize-node', id: 'a', x: 0, y: 0, width: 200, height: 100 },
      { kind: 'resize-node', id: 'b', x: 400, y: 0, width: 200, height: 100 },
    ])
  })

  it('keeps the gap between members proportional, not constant', () => {
    // The 100px gap doubles with everything else; a constant gap would leave
    // b at 300 and the group would no longer fill its own handles.
    expect(dragSouthEastBy(300, 0).commands[1]).toMatchObject({ id: 'b', x: 400 })
  })

  it('still commits a single resize when the selection is one node', () => {
    const c = pair()
    const down = reduceGesture(createIdleState(), c, {
      type: 'pointerdown-handle',
      nodeId: 'a',
      handle: 'se',
      point: { x: 100, y: 100 },
      box: { x: 0, y: 0, width: 100, height: 100 },
    })
    const up = reduceGesture(down.state, c, { type: 'pointerup', point: { x: 150, y: 100 } })
    expect(up.commands).toEqual([
      { kind: 'resize-node', id: 'a', x: 0, y: 0, width: 150, height: 100 },
    ])
  })

  it('emits nothing when the drag ended where it began', () => {
    expect(dragSouthEastBy(0, 0).commands).toEqual([])
  })
})

describe('cancel-text-edit removes a node that only existed for the cancelled edit', () => {
  const empty = (): SpatialCanvas => ({ nodes: [], edges: [] })

  it('deletes the just-created node — nothing was typed, so nothing should remain', () => {
    const created = reduceGesture(
      createIdleState(),
      empty(),
      { type: 'dblclick-empty', point: { x: 40, y: 40 } },
      { createId: () => 'n-new' },
    )
    expect(created.commands).toEqual([expect.objectContaining({ kind: 'create-node' })])

    const withNode: SpatialCanvas = {
      nodes: [{ id: 'n-new', type: 'text', x: 0, y: 0, width: 160, height: 90, text: '' }],
      edges: [],
    }
    const cancelled = reduceGesture(created.state, withNode, { type: 'cancel-text-edit' })
    expect(cancelled.state).toEqual({ kind: 'idle' })
    expect(cancelled.commands).toEqual([{ kind: 'delete-node', id: 'n-new' }])
    expect(cancelled.selectedId).toBeNull()
  })

  it('keeps an existing node — cancel reverts the edit, it does not delete', () => {
    const c = canvas()
    const editing = reduceGesture(createIdleState(), c, {
      type: 'start-text-edit',
      nodeId: 'a',
      text: 'hi',
    })
    const cancelled = reduceGesture(editing.state, c, { type: 'cancel-text-edit' })
    expect(cancelled.commands).toEqual([])
    const node = c.nodes[0]
    expect(node?.type === 'text' ? node.text : undefined).toBe('hi')
  })

  it('keeps a created node whose text was committed', () => {
    const created = reduceGesture(
      createIdleState(),
      { nodes: [], edges: [] },
      { type: 'dblclick-empty', point: { x: 10, y: 10 } },
      { createId: () => 'n-typed' },
    )
    const typed = reduceGesture(
      created.state,
      { nodes: [], edges: [] },
      {
        type: 'commit-text-edit',
        text: 'hello',
      },
    )
    expect(typed.commands).toEqual([{ kind: 'set-text', id: 'n-typed', text: 'hello' }])
  })
})
