// @vitest-environment node

import {
  createWorkspaceDocumentAtPath,
  directTarget,
  documentContainers,
  readMarkdownBody,
  readSpatialCanvas,
  readThreadMarks,
  sharedCrdtEngine,
  type WriteTarget,
  writeDocumentKind,
  writeMarkdownBody,
  writeProposal,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  base64ToBytes,
  bytesToBase64,
  type documentEngine,
  MARKDOWN_MAX_CHARS,
  type ProposedChange,
  type SpatialCanvas,
} from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const warn = vi.hoisted(() => vi.fn())
vi.mock('./app-logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./app-logger.js')>()
  return { ...actual, getAppLogger: (name: string) => ({ ...actual.getAppLogger(name), warn }) }
})

import { commandTargetKey, commitToDoc } from './command-writes.js'
import type { EditorCommand } from './spatial/commands.js'
import { applyCommand } from './spatial/commands.js'

const engine = sharedCrdtEngine()
const nodeA = textNode({ id: 'a', x: 0, y: 0, width: 100, height: 50, text: 'alpha' })
const nodeB = textNode({ id: 'b', x: 200, y: 0, width: 100, height: 50, text: 'beta' })
const BODY = 'Ship it on Thursday.\n'
const REWRITE: ProposedChange = {
  id: 'passage',
  op: 'body.replace',
  status: 'open',
  anchor: { kind: 'text', quote: { exact: 'Thursday' }, start: 11, end: 19 },
  text: 'Friday',
  assumed: 'Thursday',
}

function seed(): LoroDoc {
  const doc = new LoroDoc()
  writeDocumentKind(doc, 'markdown')
  writeSpatialCanvas(doc, { nodes: [nodeA], edges: [] })
  writeMarkdownBody(doc, BODY)
  writeProposal(doc, { id: 'p1', createdAt: '2026-09-06T00:00:00.000Z', changes: [REWRITE] })
  return doc
}

/** An engine handle over `seed()`, a target that counts the commits it makes, and a reader. */
function opened(doc: LoroDoc = seed()) {
  const { handle } = engine.open({
    peer: '7',
    bytes: bytesToBase64(doc.export({ mode: 'snapshot' })),
  })
  const commits: documentEngine.Write[][] = []
  const answer = (query: 'markdownBody') =>
    (engine.readNow({ handle, query: { query } }).value as { ok: unknown }).ok
  /** The document as the engine holds it now, read back through the adapter's readers. */
  const stored = () => {
    const doc = new LoroDoc()
    doc.import(
      base64ToBytes(engine.export({ handle, mode: 'snapshot' }).bytes ?? '') ?? new Uint8Array(),
    )
    return doc
  }
  const target: WriteTarget = {
    documentId: undefined,
    body: () => answer('markdownBody') as string,
    coreFacets: () => undefined,
    apply(writes) {
      const result = engine.write({ handle, batch: [...writes], judge: 'none' })
      if (result.outcome !== 'applied') throw new Error('refused')
      if (result.localUpdate !== undefined) commits.push([...writes])
    },
  }
  return { handle, commits, answer, stored, target }
}

/** A target that records the writes it is handed and has no document behind it. */
function capturing(documentId?: string, body = BODY): WriteTarget & { applied: string[][] } {
  const applied: string[][] = []
  return {
    documentId,
    body: () => body,
    coreFacets: () => undefined,
    apply: (writes) => void applied.push(writes.map((w) => JSON.stringify(w))),
    applied,
  }
}

const canvasOf = (...nodes: SpatialCanvas['nodes']): SpatialCanvas => ({ nodes, edges: [] })
const commit = (
  target: WriteTarget,
  prev: SpatialCanvas,
  command: EditorCommand,
): SpatialCanvas => {
  const next = applyCommand(prev, command)
  commitToDoc(target, prev, next, command)
  return next
}

let open: number[] = []
beforeEach(() => {
  warn.mockClear()
})
afterEach(() => {
  for (const handle of open) engine.close({ handle })
  open = []
})
const track = (made: ReturnType<typeof opened>) => {
  open.push(made.handle)
  return made
}

describe('one command is one engine commit', () => {
  it('writes a thread and the mark on its passage in ONE commit', () => {
    const { target, commits, stored } = track(opened())
    const prev = canvasOf(nodeA)

    commit(target, prev, {
      kind: 'create-thread',
      thread: {
        id: 't-passage',
        anchor: { kind: 'text', quote: { exact: 'plan' }, start: 4, end: 8 },
        status: 'open',
        messages: [{ id: 'm1', body: 'which?' }],
      },
    })

    expect(commits).toHaveLength(1)
    expect(commits[0]?.map((w) => w.op)).toEqual(['writeCommentThread', 'markThreadPassages'])
    expect(readThreadMarks(stored()).get('t-passage')).toEqual({ start: 4, end: 8 })
  })

  it('adopts a passage and stamps its status in ONE commit, the body rewritten from the text the plan read', () => {
    const { target, commits, answer } = track(opened())
    const command: EditorCommand = {
      kind: 'decide-proposal',
      proposalId: 'p1',
      decision: 'adopted',
      changes: [REWRITE],
    }

    commit(target, canvasOf(nodeA), command)

    expect(commits).toHaveLength(1)
    expect(commits[0]?.map((w) => w.op)).toEqual(['withDocumentBatch'])
    expect(answer('markdownBody')).toBe('Ship it on Friday.\n')
  })

  it('writes nothing for an adoption that would leave the body past its limit, so the change stays open', () => {
    const target = capturing(undefined, BODY)
    const grow: ProposedChange = { ...REWRITE, text: 'x'.repeat(MARKDOWN_MAX_CHARS) }
    const command: EditorCommand = {
      kind: 'decide-proposal',
      proposalId: 'p1',
      decision: 'adopted',
      changes: [grow],
    }
    const prev = canvasOf(nodeA)

    commitToDoc(target, prev, applyCommand(prev, command), command)

    expect(target.applied).toEqual([[]])
  })

  it('writes a batch of members as one write step list', () => {
    const { target, commits } = track(opened())

    commit(target, canvasOf(nodeA), {
      kind: 'batch',
      commands: [
        { kind: 'create-node', node: nodeB },
        { kind: 'move-node', id: 'a', x: 9, y: 9 },
      ],
    })

    expect(commits).toHaveLength(1)
    expect(commits[0]).toHaveLength(1)
    expect(commits[0]?.[0]?.op).toBe('withSpatialBatch')
  })

  it('commits once per distinct target of a window: create A, create B, move A is two commits', () => {
    const { target, commits, stored } = track(opened())
    const nodeC = textNode({ id: 'c', x: 0, y: 200, width: 100, height: 50, text: 'c' })
    const queued: EditorCommand[] = [
      { kind: 'create-node', node: nodeB },
      { kind: 'create-node', node: nodeC },
      { kind: 'move-node', id: 'b', x: 1, y: 1 },
    ]
    // The canvas after the whole window, as the editor's reducer hands every queued command.
    const next = queued.reduce(applyCommand, canvasOf(nodeA))
    const targets = new Map(queued.map((command) => [commandTargetKey(command), command]))

    for (const command of targets.values()) commitToDoc(target, canvasOf(nodeA), next, command)

    expect(targets.size).toBe(2)
    expect(commits).toHaveLength(2)
    expect(
      readSpatialCanvas(stored())
        .nodes.map((n) => n.id)
        .sort(),
    ).toEqual(['a', 'b', 'c'])
  })
})

describe('a command whose write fails', () => {
  const prev = canvasOf(nodeA)
  const command: EditorCommand = { kind: 'move-node', id: 'a', x: 5, y: 5 }
  const next = applyCommand(prev, command)

  it('is retried as the whole-canvas reconcile, and the failure is warned about', () => {
    const applied: string[] = []
    let calls = 0
    const target: WriteTarget = {
      documentId: undefined,
      body: () => '',
      coreFacets: () => undefined,
      apply(writes) {
        calls += 1
        if (calls === 1) throw new Error('fine-grained write failed')
        applied.push(...writes.map((w) => w.op))
      },
    }

    commitToDoc(target, prev, next, command)

    expect(applied).toEqual(['reconcileSpatialCanvas'])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('rethrows when the reconcile fails too, leaving the target usable for the next command', () => {
    const { target, stored } = track(opened())
    let failing = true
    const flaky: WriteTarget = {
      ...target,
      apply(writes) {
        if (failing) throw new Error('down')
        target.apply(writes)
      },
    }

    expect(() => commitToDoc(flaky, prev, next, command)).toThrow('down')
    failing = false
    commitToDoc(flaky, prev, next, command)

    expect(readSpatialCanvas(stored()).nodes[0]).toMatchObject({ x: 5, y: 5 })
  })

  it('reconciles instead of planning when a read the plan needs throws', () => {
    const applied: string[] = []
    const target: WriteTarget = {
      documentId: undefined,
      body: () => {
        throw new Error('the node is gone')
      },
      coreFacets: () => undefined,
      apply: (writes) => void applied.push(...writes.map((w) => w.op)),
    }
    const decide: EditorCommand = {
      kind: 'decide-proposal',
      proposalId: 'p1',
      decision: 'adopted',
      changes: [REWRITE],
    }

    commitToDoc(target, prev, applyCommand(prev, decide), decide)

    expect(applied).toEqual(['reconcileSpatialCanvas'])
  })

  it('warns once, and reconciles, for a target the next canvas does not hold', () => {
    const target = capturing()

    commitToDoc(target, prev, prev, { kind: 'move-node', id: 'ghost', x: 1, y: 1 })

    expect(target.applied.map((writes) => writes.map((w) => JSON.parse(w).op))).toEqual([
      ['reconcileSpatialCanvas'],
    ])
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('a hosted document', () => {
  const DOCUMENT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

  it('is written on its own tree node, and the roots of the workspace record stay empty', () => {
    const ws = new LoroDoc()
    createWorkspaceDocumentAtPath(ws, { path: 'note', documentId: DOCUMENT_ID, kind: 'markdown' })
    const prev = canvasOf()

    commit(directTarget(ws, DOCUMENT_ID), prev, { kind: 'set-body', text: '# hosted' })

    expect(readMarkdownBody(documentContainers(ws, DOCUMENT_ID))).toBe('# hosted')
    expect(ws.getText('body').toString()).toBe('')
  })

  it('stamps its id into every write of a plan, and into none for a root document', () => {
    const command: EditorCommand = { kind: 'set-body', text: 'x' }
    const prev = canvasOf()
    const hosted = capturing(DOCUMENT_ID)
    const root = capturing()

    commitToDoc(hosted, prev, prev, command)
    commitToDoc(root, prev, prev, command)

    expect(hosted.applied).toEqual([
      [JSON.stringify({ op: 'writeMarkdownBody', args: { body: 'x', documentId: DOCUMENT_ID } })],
    ])
    expect(root.applied).toEqual([
      [JSON.stringify({ op: 'writeMarkdownBody', args: { body: 'x' } })],
    ])
  })
})

describe('the facets a set-facets command replaces', () => {
  it('are read through the target, so a field this build cannot read survives', () => {
    const doc = seed()
    const target = directTarget(doc)
    const prev = canvasOf()
    commit(target, prev, { kind: 'set-facets', facets: { type: 'note', tags: ['a'] } })
    doc.getMap('core').set('futureField', 1)
    doc.commit()

    commit(target, prev, { kind: 'set-facets', facets: { type: 'note', tags: ['b'] } })

    expect(doc.getMap('core').toJSON()).toMatchObject({ futureField: 1 })
  })
})
