// @vitest-environment node

import {
  readCommentThreads,
  readCoreFacets,
  readMarkdownBody,
  readProposals,
  readSpatialCanvas,
  readThreadMarks,
  writeCommentThread,
  writeDocumentKind,
  writeMarkdownBody,
  writeProposal,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import type { ProposedChange, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The fallback to a whole-canvas reconcile always logs first (see
// `commitToDoc`), so the warning is how a test tells "wrote the one target"
// from "fell back" without inferring it from the document.
const appLoggerSpies = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('./app-logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./app-logger.js')>()
  return {
    ...actual,
    getAppLogger: (name: string) => ({ ...actual.getAppLogger(name), warn: appLoggerSpies.warn }),
  }
})

import { commandTargetKey, commitToDoc } from './command-writes.js'
import type { EditorCommand } from './spatial/commands.js'
import { applyCommand } from './spatial/commands.js'

const nodeA = textNode({ id: 'a', x: 0, y: 0, width: 100, height: 50, text: 'alpha' })
const nodeB = textNode({ id: 'b', x: 200, y: 0, width: 100, height: 50, text: 'beta' })

function canvasOf(...nodes: SpatialCanvas['nodes']): SpatialCanvas {
  return { nodes: [...nodes], edges: [] }
}

function docHolding(canvas: SpatialCanvas): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, canvas)
  return doc
}

function noteHolding(body: string): LoroDoc {
  const doc = new LoroDoc()
  writeDocumentKind(doc, 'markdown')
  writeMarkdownBody(doc, body)
  return doc
}

/** Applies `command` to the canvas the doc holds and commits it, as the session does. */
function commit(doc: LoroDoc, command: EditorCommand): SpatialCanvas {
  const prev = readSpatialCanvas(doc)
  const next = applyCommand(prev, command)
  commitToDoc(doc, doc, prev, next, command)
  return next
}

/** Counts the update payloads a local commit emits — one per commit. */
function countLocalUpdates(doc: LoroDoc): () => number {
  let count = 0
  doc.subscribeLocalUpdates(() => {
    count += 1
  })
  return () => count
}

beforeEach(() => {
  appLoggerSpies.warn.mockClear()
})

describe('commandTargetKey', () => {
  it('keys every command aimed at one node to that node, so a burst dedupes to the last', () => {
    const keys = [
      { kind: 'move-node', id: 'a', x: 1, y: 1 },
      { kind: 'resize-node', id: 'a', x: 0, y: 0, width: 10, height: 10 },
      { kind: 'set-text', id: 'a', text: 'x' },
      { kind: 'delete-node', id: 'a' },
      { kind: 'create-node', node: nodeA },
    ] satisfies EditorCommand[]

    expect(new Set(keys.map(commandTargetKey))).toEqual(new Set(['node:a']))
    expect(commandTargetKey({ kind: 'move-node', id: 'b', x: 1, y: 1 })).toBe('node:b')
  })

  it('keys a reply by its MESSAGE, because a reply appends and two in one window are two writes', () => {
    const reply = (id: string): EditorCommand => ({
      kind: 'reply-to-thread',
      threadId: 't1',
      message: { id, body: 'x' },
    })

    expect(commandTargetKey(reply('m1'))).not.toBe(commandTargetKey(reply('m2')))
    expect(commandTargetKey(reply('m1'))).toBe('message:m1')
  })

  it('keys a created thread by the thread: two of one id are one target written twice', () => {
    const create = (id: string): EditorCommand => ({
      kind: 'create-thread',
      thread: { id, anchor: { kind: 'document' }, status: 'open', messages: [] },
    })

    expect(commandTargetKey(create('t1'))).toBe(commandTargetKey(create('t1')))
    expect(commandTargetKey(create('t1'))).not.toBe(commandTargetKey(create('t2')))
  })

  it('keys the body and the facets as one target each, and a decision by its proposal', () => {
    expect(commandTargetKey({ kind: 'set-body', text: 'a' })).toBe('body')
    expect(commandTargetKey({ kind: 'set-body', text: 'b' })).toBe('body')
    expect(commandTargetKey({ kind: 'set-facets', facets: { type: 'note' } })).toBe('facets')
    expect(
      commandTargetKey({
        kind: 'decide-proposal',
        proposalId: 'p1',
        decision: 'adopted',
        changes: [],
      }),
    ).toBe('proposal:p1')
  })

  it('never dedupes a batch or an unmapped kind against another', () => {
    const batch: EditorCommand = { kind: 'batch', commands: [] }
    const unmapped: EditorCommand = { kind: 'set-edge-routing', style: 'curved' }

    expect(commandTargetKey(batch)).not.toBe(commandTargetKey(batch))
    expect(commandTargetKey(unmapped)).not.toBe(commandTargetKey(unmapped))
  })
})

describe('commitToDoc', () => {
  it('writes the node a command names without falling back', () => {
    const doc = docHolding(canvasOf(nodeA, nodeB))

    commit(doc, { kind: 'move-node', id: 'a', x: 40, y: 60 })

    const stored = readSpatialCanvas(doc)
    expect(stored.nodes.find((n) => n.id === 'a')).toMatchObject({ x: 40, y: 60 })
    expect(stored.nodes.find((n) => n.id === 'b')).toMatchObject({ x: 200, y: 0 })
    expect(appLoggerSpies.warn).not.toHaveBeenCalled()
  })

  it('falls back to reconciling the whole canvas when the target is missing from next', () => {
    const doc = docHolding(canvasOf(nodeA, nodeB))
    const prev = readSpatialCanvas(doc)
    // `ghost` names nothing in `next`, and `next` has also lost `b` without a
    // command saying so — which only the whole-canvas reconcile can notice.
    const next = canvasOf(nodeA)

    commitToDoc(doc, doc, prev, next, { kind: 'move-node', id: 'ghost', x: 1, y: 1 })

    expect(readSpatialCanvas(doc).nodes.map((n) => n.id)).toEqual(['a'])
    expect(appLoggerSpies.warn).toHaveBeenCalledTimes(1)
  })

  it('deletes by id with no fallback, even for an id the doc never held', () => {
    const doc = docHolding(canvasOf(nodeA))

    commit(doc, { kind: 'delete-node', id: 'never-there' })
    commit(doc, { kind: 'delete-node', id: 'a' })

    expect(readSpatialCanvas(doc).nodes).toEqual([])
    expect(appLoggerSpies.warn).not.toHaveBeenCalled()
  })

  it('writes a body edit that the whole-canvas fallback would drop', () => {
    const doc = docHolding(canvasOf())

    commit(doc, { kind: 'set-body', text: '# Hello\n' })

    expect(readMarkdownBody(doc)).toBe('# Hello\n')
    expect(appLoggerSpies.warn).not.toHaveBeenCalled()
  })

  it('writes the core facets, which live outside the canvas', () => {
    const doc = noteHolding('')

    commit(doc, { kind: 'set-facets', facets: { type: 'note', tags: ['draft'] } })

    expect(readCoreFacets(doc)).toMatchObject({ type: 'note', tags: ['draft'] })
    expect(appLoggerSpies.warn).not.toHaveBeenCalled()
  })

  describe('the conversation plane', () => {
    function docWithThread(): LoroDoc {
      const doc = docHolding(canvasOf())
      writeCommentThread(doc, {
        id: 't1',
        anchor: { kind: 'document' },
        status: 'open',
        messages: [{ id: 'm1', body: 'opening' }],
      })
      return doc
    }

    it('appends a reply to the thread it names', () => {
      const doc = docWithThread()

      commit(doc, { kind: 'reply-to-thread', threadId: 't1', message: { id: 'm2', body: 'reply' } })

      expect(readCommentThreads(doc)[0]?.messages.map((m) => m.body)).toEqual(['opening', 'reply'])
      expect(appLoggerSpies.warn).not.toHaveBeenCalled()
    })

    it('never opens a thread this replica does not hold by replying to it', () => {
      const doc = docWithThread()

      commit(doc, { kind: 'reply-to-thread', threadId: 'absent', message: { id: 'm2', body: 'x' } })

      expect(readCommentThreads(doc).map((t) => t.id)).toEqual(['t1'])
      expect(appLoggerSpies.warn).not.toHaveBeenCalled()
    })

    it('rewrites a message in place when it is edited', () => {
      const doc = docWithThread()

      commit(doc, {
        kind: 'edit-thread-message',
        threadId: 't1',
        message: { id: 'm1', body: 'reworded' },
        opening: true,
      })

      expect(readCommentThreads(doc)[0]?.messages).toMatchObject([{ id: 'm1', body: 'reworded' }])
    })

    it('stamps a status on the thread', () => {
      const doc = docWithThread()

      commit(doc, { kind: 'set-thread-status', threadId: 't1', status: 'resolved' })

      expect(readCommentThreads(doc)[0]?.status).toBe('resolved')
      expect(appLoggerSpies.warn).not.toHaveBeenCalled()
    })

    it('opens a thread and marks its passage so the CRDT carries it through later edits', () => {
      const doc = docHolding(canvasOf())
      writeMarkdownBody(doc, 'The plan is to ship.\n')

      commit(doc, {
        kind: 'create-thread',
        thread: {
          id: 't-passage',
          anchor: { kind: 'text', quote: { exact: 'plan' }, start: 4, end: 8 },
          status: 'open',
          messages: [{ id: 'm1', body: 'which plan?' }],
        },
      })

      expect(readCommentThreads(doc).map((t) => t.id)).toEqual(['t-passage'])
      expect(readThreadMarks(doc).get('t-passage')).toEqual({ start: 4, end: 8 })
    })
  })

  describe('a batch', () => {
    it('writes its members as ONE update when every member is writable', () => {
      const doc = docHolding(canvasOf(nodeA, nodeB))
      const updates = countLocalUpdates(doc)

      commit(doc, {
        kind: 'batch',
        commands: [
          { kind: 'move-node', id: 'a', x: 5, y: 5 },
          { kind: 'move-node', id: 'b', x: 6, y: 6 },
        ],
      })

      expect(updates()).toBe(1)
      const stored = readSpatialCanvas(doc)
      expect(stored.nodes.find((n) => n.id === 'a')).toMatchObject({ x: 5, y: 5 })
      expect(stored.nodes.find((n) => n.id === 'b')).toMatchObject({ x: 6, y: 6 })
      expect(appLoggerSpies.warn).not.toHaveBeenCalled()
    })

    it('is all-or-nothing: one member the writer cannot take sends the whole batch to the reconcile', () => {
      const doc = docHolding(canvasOf(nodeA, nodeB))

      commit(doc, {
        kind: 'batch',
        commands: [
          { kind: 'move-node', id: 'a', x: 5, y: 5 },
          { kind: 'set-edge-routing', style: 'curved' },
        ],
      })

      // An unmapped member is the designed path to the reconcile, not a
      // warning; the move still lands through it.
      expect(appLoggerSpies.warn).not.toHaveBeenCalled()
      expect(readSpatialCanvas(doc).nodes.find((n) => n.id === 'a')).toMatchObject({ x: 5, y: 5 })
    })

    it('sends the batch to the reconcile when a member names a node next does not hold', () => {
      const doc = docHolding(canvasOf(nodeA))

      commit(doc, {
        kind: 'batch',
        commands: [
          { kind: 'move-node', id: 'a', x: 5, y: 5 },
          { kind: 'move-node', id: 'ghost', x: 1, y: 1 },
        ],
      })

      expect(appLoggerSpies.warn).toHaveBeenCalledTimes(1)
      expect(readSpatialCanvas(doc).nodes.find((n) => n.id === 'a')).toMatchObject({ x: 5, y: 5 })
    })
  })

  describe('deciding a proposal', () => {
    const moveA: ProposedChange = {
      id: 'node:a',
      op: 'node.patch',
      status: 'open',
      nodeId: 'a',
      patch: { x: 240 },
      assumed: { x: 0 },
    }
    const rewrite: ProposedChange = {
      id: 'passage',
      op: 'body.replace',
      status: 'open',
      anchor: { kind: 'text', quote: { exact: 'Thursday' }, start: 11, end: 19 },
      text: 'Friday',
      assumed: 'Thursday',
    }

    function board(): LoroDoc {
      const doc = docHolding(canvasOf(nodeA))
      writeProposal(doc, { id: 'p1', createdAt: '2026-09-06T00:00:00.000Z', changes: [moveA] })
      return doc
    }

    function note(): LoroDoc {
      const doc = noteHolding('Ship it on Thursday.\n')
      writeProposal(doc, { id: 'p1', createdAt: '2026-09-06T00:00:00.000Z', changes: [rewrite] })
      return doc
    }

    const decide = (
      decision: 'adopted' | 'dismissed',
      changes: readonly ProposedChange[],
    ): EditorCommand => ({ kind: 'decide-proposal', proposalId: 'p1', decision, changes })

    it('adopts a board change and stamps its status in ONE update', () => {
      const doc = board()
      const updates = countLocalUpdates(doc)

      commit(doc, decide('adopted', [moveA]))

      expect(updates()).toBe(1)
      expect(readSpatialCanvas(doc).nodes[0]).toMatchObject({ x: 240 })
      expect(readProposals(doc)[0]?.changes[0]?.status).toBe('adopted')
    })

    it('adopts a passage and stamps its status in ONE update', () => {
      const doc = note()
      const updates = countLocalUpdates(doc)

      commit(doc, decide('adopted', [rewrite]))

      expect(updates()).toBe(1)
      expect(readMarkdownBody(doc)).toBe('Ship it on Friday.\n')
      expect(readProposals(doc)[0]?.changes[0]?.status).toBe('adopted')
    })

    it('dismisses by stamping the status alone, leaving the board as it was', () => {
      const doc = board()
      const prev = readSpatialCanvas(doc)
      const command = decide('dismissed', [moveA])
      // `next` carries the move on purpose: a dismissal must not write it.
      const next = applyCommand(prev, decide('adopted', [moveA]))

      commitToDoc(doc, doc, prev, next, command)

      expect(readSpatialCanvas(doc).nodes[0]).toMatchObject({ x: 0 })
      expect(readProposals(doc)[0]?.changes[0]?.status).toBe('dismissed')
    })

    it('dismisses a passage without touching the body', () => {
      const doc = note()

      commit(doc, decide('dismissed', [rewrite]))

      expect(readMarkdownBody(doc)).toBe('Ship it on Thursday.\n')
      expect(readProposals(doc)[0]?.changes[0]?.status).toBe('dismissed')
    })
  })
})
