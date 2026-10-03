import {
  readCoreFacets,
  readSpatialCanvas,
  writeCoreFacets,
  writeProposal,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import type { Proposal, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import { commitToDoc } from './command-writes.js'
import type { EditorCommand } from './spatial/commands.js'
import { applyCommand } from './spatial/commands.js'

const A = textNode({ id: 'a', text: 'alpha', x: 0, y: 0, width: 10, height: 10 })
const B = textNode({ id: 'b', text: 'beta', x: 50, y: 0, width: 10, height: 10 })
const point = (x: number, y: number) => ({ kind: 'point' as const, point: { x, y } })

/** What a newer client wrote: valid there, refused by this build's strict schema. */
function plantUnreadable(doc: LoroDoc): void {
  doc.getMap('nodes').set('future-node', { ...A, id: 'future-node', fieldFromTheFuture: 1 })
  doc.getMap('edges').set('future-edge', {
    id: 'future-edge',
    from: { node: 'a' },
    to: { node: 'b' },
    fieldFromTheFuture: 1,
  })
  doc.getMap('lines').set('future-line', {
    id: 'future-line',
    from: point(0, 0),
    to: point(1, 1),
    fieldFromTheFuture: 1,
  })
  doc.commit()
}

const ids = (doc: LoroDoc, map: 'nodes' | 'edges' | 'lines') =>
  Object.keys(doc.getMap(map).toJSON()).sort()

/** A doc this build can partly read, and the canvas the editor was handed from it. */
function seeded(): { doc: LoroDoc; prev: SpatialCanvas } {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, { nodes: [A, B], edges: [] })
  plantUnreadable(doc)
  return { doc, prev: readSpatialCanvas(doc) }
}

describe('commitToDoc over records this build cannot read', () => {
  it('keeps an unreadable node, edge and line when an unmapped command falls back to the whole canvas', async () => {
    const { doc, prev } = seeded()
    const command: EditorCommand = { kind: 'set-node-color', id: 'a', color: '1' }
    const next = applyCommand(prev, command)
    expect(next).not.toBe(prev)

    commitToDoc(doc, doc, prev, next, command)

    expect(ids(doc, 'nodes')).toEqual(['a', 'b', 'future-node'])
    expect(ids(doc, 'edges')).toEqual(['future-edge'])
    expect(ids(doc, 'lines')).toEqual(['future-line'])
    expect(readSpatialCanvas(doc).nodes.find((n) => n.id === 'a')?.color).toBe('1')
    await expectLoggedFailure('editor command target missing')
  })

  it('keeps them when one member of a batch has no fine-grained write', async () => {
    const { doc, prev } = seeded()
    const command: EditorCommand = {
      kind: 'batch',
      commands: [
        { kind: 'move-node', id: 'b', x: 70, y: 0 },
        { kind: 'set-node-color', id: 'a', color: '2' },
      ],
    }

    commitToDoc(doc, doc, prev, applyCommand(prev, command), command)

    expect(ids(doc, 'nodes')).toEqual(['a', 'b', 'future-node'])
    expect(ids(doc, 'edges')).toEqual(['future-edge'])
    expect(ids(doc, 'lines')).toEqual(['future-line'])
    await expectLoggedFailure('editor command target missing')
  })

  it('keeps them when the proposal an adopted decision answers rewrites the board', () => {
    const { doc, prev } = seeded()
    const proposal: Proposal = {
      id: 'p1',
      createdAt: '2026-09-06T00:00:00.000Z',
      changes: [
        {
          id: 'node:a',
          op: 'node.patch',
          status: 'open',
          nodeId: 'a',
          patch: { x: 240 },
          assumed: { x: 0 },
        },
      ],
    }
    writeProposal(doc, proposal)
    const command: EditorCommand = {
      kind: 'decide-proposal',
      proposalId: 'p1',
      decision: 'adopted',
      changes: proposal.changes,
    }

    commitToDoc(doc, doc, prev, applyCommand(prev, command), command)

    expect(readSpatialCanvas(doc).nodes.find((n) => n.id === 'a')?.x).toBe(240)
    expect(ids(doc, 'nodes')).toEqual(['a', 'b', 'future-node'])
    expect(ids(doc, 'edges')).toEqual(['future-edge'])
    expect(ids(doc, 'lines')).toEqual(['future-line'])
  })

  it('keeps them under a fine-grained command too', () => {
    const { doc, prev } = seeded()
    const command: EditorCommand = { kind: 'move-node', id: 'a', x: 5, y: 5 }

    commitToDoc(doc, doc, prev, applyCommand(prev, command), command)

    expect(ids(doc, 'nodes')).toEqual(['a', 'b', 'future-node'])
    expect(ids(doc, 'edges')).toEqual(['future-edge'])
    expect(ids(doc, 'lines')).toEqual(['future-line'])
  })
})

describe('commitToDoc over a canvas the editor could see', () => {
  it('still deletes what the editor visibly dropped, and its lock with it', async () => {
    const { doc, prev } = seeded()
    doc.getMap('nodeLocks').set('b', true)
    doc.commit()
    const command: EditorCommand = { kind: 'set-node-color', id: 'a', color: '1' }
    const next = { ...applyCommand(prev, command), nodes: [A] }

    commitToDoc(doc, doc, prev, next, command)

    expect(ids(doc, 'nodes')).toEqual(['a', 'future-node'])
    expect(Object.keys(doc.getMap('nodeLocks').toJSON())).toEqual([])
    await expectLoggedFailure('editor command target missing')
  })

  it('does not delete a record the editor never held, such as a peer node merged mid-window', async () => {
    const { doc, prev } = seeded()
    doc.getMap('nodes').set('peer', { ...B, id: 'peer' })
    doc.commit()
    const command: EditorCommand = { kind: 'set-node-color', id: 'a', color: '1' }

    commitToDoc(doc, doc, prev, applyCommand(prev, command), command)

    expect(ids(doc, 'nodes')).toEqual(['a', 'b', 'future-node', 'peer'])
    await expectLoggedFailure('editor command target missing')
  })

  it('writes an unchanged canvas as nothing', async () => {
    const { doc, prev } = seeded()
    const before = doc.oplogVersion()
    const command: EditorCommand = { kind: 'set-node-color', id: 'a', color: undefined }

    commitToDoc(doc, doc, prev, prev, command)

    expect(doc.oplogVersion().compare(before)).toBe(0)
    await expectLoggedFailure('editor command target missing')
  })
})

describe('commitToDoc over envelope entries this build cannot read', () => {
  it('keeps a core field it does not know when the properties panel rewrites the facets', () => {
    const doc = new LoroDoc()
    writeCoreFacets(doc, { type: 'note', tags: ['one'] })
    doc.getMap('core').set('futureCoreField', { nested: 1 })
    doc.commit()
    expect(readCoreFacets(doc)).toEqual({ type: 'note', tags: ['one'] })
    const empty: SpatialCanvas = { nodes: [], edges: [] }

    commitToDoc(doc, doc, empty, empty, {
      kind: 'set-facets',
      facets: { type: 'note', tags: ['one', 'two'] },
    })

    expect(readCoreFacets(doc)).toEqual({ type: 'note', tags: ['one', 'two'] })
    expect(doc.getMap('core').get('futureCoreField')).toEqual({ nested: 1 })
  })

  it('still removes a core field the panel dropped', () => {
    const doc = new LoroDoc()
    writeCoreFacets(doc, { type: 'note', view: 'board', tags: ['one'] })
    const empty: SpatialCanvas = { nodes: [], edges: [] }

    commitToDoc(doc, doc, empty, empty, { kind: 'set-facets', facets: { type: 'note' } })

    expect(doc.getMap('core').toJSON()).toEqual({ type: 'note' })
  })

  it('keeps a canvas facet beside an out-of-grammar key when another canvas facet is set', async () => {
    const doc = new LoroDoc()
    writeSpatialCanvas(doc, { nodes: [A], edges: [] })
    doc.getMap('canvas').set('facets', {
      'visual.theme/v0': { theme: 'visual.neon' },
      'Bad Key': { from: 'the future' },
    })
    doc.commit()
    const prev = readSpatialCanvas(doc)
    const command: EditorCommand = {
      kind: 'set-canvas-facet',
      key: 'visual.edges/v0',
      payload: { routing: 'orthogonal' },
    }

    commitToDoc(doc, doc, prev, applyCommand(prev, command), command)

    expect(doc.getMap('canvas').get('facets')).toEqual({
      'visual.theme/v0': { theme: 'visual.neon' },
      'visual.edges/v0': { routing: 'orthogonal' },
      'Bad Key': { from: 'the future' },
    })
    await expectLoggedFailure('editor command target missing')
  })

  it('removes the canvas facet the editor cleared and keeps the one it could not read', async () => {
    const doc = new LoroDoc()
    writeSpatialCanvas(doc, { nodes: [A], edges: [] })
    doc.getMap('canvas').set('facets', {
      'visual.theme/v0': { theme: 'visual.neon' },
      'Bad Key': { from: 'the future' },
    })
    doc.commit()
    const prev = readSpatialCanvas(doc)
    const command: EditorCommand = {
      kind: 'set-canvas-facet',
      key: 'visual.theme/v0',
      payload: undefined,
    }

    commitToDoc(doc, doc, prev, applyCommand(prev, command), command)

    expect(doc.getMap('canvas').get('facets')).toEqual({ 'Bad Key': { from: 'the future' } })
    await expectLoggedFailure('editor command target missing')
  })
})
