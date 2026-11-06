/**
 * A live update that newly writes a shape an older version stored and no
 * reader serves any more is refused where it arrives, by both keepers: the
 * daemon would otherwise keep bytes every reader then refuses on read.
 * Only a shape NEWLY written is refused — a delete is the repair, and a
 * document that already holds one stays editable.
 */
import { LoroDoc, LoroMovableList } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import { CANVAS_KEY, DOCUMENT_KEY, EDGES_KEY, NODES_KEY, THREADS_KEY } from './containers.js'
import {
  importWithinTextLimits,
  judgeStateWithinTextLimits,
  SYNC_TEXT_BREACH_CODES,
  syncTextLimitJudge,
} from './sync-text-limits.js'
import { createWorkspaceDocumentAtPath, documentContainers } from './workspace-tree.js'

const BOARD = '01RSAAAAAAAAAAAAAAAAAAAAA0'
const NOTE = '01RSAAAAAAAAAAAAAAAAAAAAA1'

/** A workspace record holding one board and one note. */
function record(): LoroDoc {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: 'board', documentId: BOARD, kind: 'spatial' })
  createWorkspaceDocumentAtPath(doc, { path: 'note', documentId: NOTE, kind: 'markdown' })
  documentContainers(doc, BOARD).getMap(NODES_KEY).set('n1', { id: 'n1', text: 'keep me' })
  doc.commit()
  return doc
}

/**
 * An update with the edit, padded past the browser keeper's short path unless
 * `short`: that path is told by the keys an update spells, and an op into a
 * container that already exists spells none, so a verdict about the shape
 * itself is asked of the full judge.
 */
function updateFrom(
  base: LoroDoc,
  edit: (doc: LoroDoc, board: ReturnType<typeof documentContainers>) => void,
  documentId = BOARD,
  short = false,
): Uint8Array {
  const client = base.fork()
  const from = client.oplogVersion()
  if (!short) {
    documentContainers(client, BOARD)
      .getMap(NODES_KEY)
      .set('pad', { id: 'pad', text: 'p'.repeat(2_000) })
  }
  edit(client, documentContainers(client, documentId))
  client.commit()
  return client.export({ mode: 'update', from })
}

/** Both keepers' verdicts, which must agree. */
function judged(base: LoroDoc, update: Uint8Array) {
  const imported = importWithinTextLimits(base.fork(), update).breach
  expect(syncTextLimitJudge(base)(update)).toEqual(imported)
  return imported
}

const elementsOf = (doc: LoroDoc, id: string): LoroMovableList => {
  const node = doc
    .getTree('tree')
    .getNodes()
    .find((candidate) => candidate.data.get('documentId') === id)
  if (node === undefined) throw new Error('the document is gone')
  const held = node.data.get('elements')
  return held instanceof LoroMovableList
    ? held
    : node.data.setContainer('elements', new LoroMovableList())
}

const WRITES: ReadonlyArray<
  readonly [
    string,
    (doc: LoroDoc, host: ReturnType<typeof documentContainers>) => void,
    string,
    string?,
  ]
> = [
  [
    'a node under x-whiteboard',
    (_d, h) => h.getMap(NODES_KEY).set('n2', { id: 'n2', 'x-whiteboard': { a: 1 } }),
    'retired-shape',
  ],
  [
    'a node in the pre-ADR-0038 kind union',
    (_d, h) => h.getMap(NODES_KEY).set('n2', { id: 'n2', type: 'text', text: 'x' }),
    'retired-shape',
  ],
  [
    'an edge under x-whiteboard',
    (_d, h) => h.getMap(EDGES_KEY).set('e1', { id: 'e1', 'x-whiteboard': {} }),
    'retired-shape',
  ],
  [
    'canvas settings under x-whiteboard',
    (_d, h) => h.getMap(CANVAS_KEY).set('x-whiteboard', { a: 1 }),
    'retired-shape',
  ],
  [
    'a row in the flat comments plane',
    (_d, h) => h.getMap('comments').set('c1', { id: 'c1', text: 'old' }),
    'retired-comment-plane',
  ],
  [
    'an entry in the elements list',
    (d) => elementsOf(d, BOARD).push({ id: 'el' }),
    'retired-shape',
  ],
  [
    'a markdown body stored as the okf-body node',
    (_d, h) => h.getMap(NODES_KEY).set('okf-body', { id: 'okf-body', text: 'x' }),
    'retired-shape',
    NOTE,
  ],
]

describe('an update newly writing a retired stored shape', () => {
  it.each(
    WRITES.map(([what, edit, shape, documentId]) => ({ what, edit, shape, documentId })),
  )('is refused when it writes $what', ({ edit, shape, documentId }) => {
    const base = record()
    const update = updateFrom(base, edit, documentId)

    const breach = judged(base, update)

    expect(breach).toMatchObject({ shape, container: expect.any(String) })
  })

  it('names the document it was written into', () => {
    const base = record()
    const update = updateFrom(base, (_d, h) => h.getMap(NODES_KEY).set('n2', { 'x-whiteboard': 1 }))

    const breach = judged(base, update)

    const applied = base.fork()
    applied.import(update)
    expect(
      applied.getPathToContainer((breach as unknown as { container: never }).container)?.[0],
    ).toBe('tree')
  })

  it('is answered with the same codes the read refusals carry', () => {
    expect(SYNC_TEXT_BREACH_CODES['retired-shape']).toBe('retired_stored_shape')
    expect(SYNC_TEXT_BREACH_CODES['retired-comment-plane']).toBe('retired_comment_plane')
  })

  it('leaves a short write of the old node-kind union to the full judge', () => {
    const base = record()
    const update = updateFrom(
      base,
      (_d, h) => h.getMap(NODES_KEY).set('n2', { id: 'n2', type: 'text' }),
      BOARD,
      true,
    )

    expect(update.byteLength).toBeLessThanOrEqual(1024)
    expect(importWithinTextLimits(base.fork(), update).breach).toMatchObject({
      shape: 'retired-shape',
    })
    expect(syncTextLimitJudge(base)(update)).toBeNull()
  })

  it('is refused for a standalone document too', () => {
    const base = new LoroDoc()
    base.getMap(NODES_KEY).set('n1', { id: 'n1' })
    base.commit()
    const client = base.fork()
    const from = client.oplogVersion()
    client.getMap(NODES_KEY).set('n2', { id: 'n2', 'x-whiteboard': {} })
    client.getMap('comments').set('c', { id: 'c' })
    client.commit()
    const update = client.export({ mode: 'update', from })

    expect(judged(base, update)).toMatchObject({ shape: 'retired-shape' })
    const clean = base.fork()
    const only = clean.fork()
    only.getMap('comments').set('c', { id: 'c' })
    only.commit()
    expect(judged(base, only.export({ mode: 'update', from: base.oplogVersion() }))).toMatchObject({
      shape: 'retired-comment-plane',
      rows: 1,
    })
  })

  it('is refused when the root holding it is created by the update', () => {
    const base = new LoroDoc()
    base.getMap(NODES_KEY).set('n1', { id: 'n1' })
    base.commit()
    const client = base.fork()
    const from = client.oplogVersion()
    client.getMap(EDGES_KEY).set('e', { 'x-whiteboard': {} })
    client.commit()

    expect(judged(base, client.export({ mode: 'update', from }))).toMatchObject({
      shape: 'retired-shape',
    })
  })

  describe('what already stands is not the update’s doing', () => {
    const held = (base: LoroDoc) => {
      documentContainers(base, BOARD)
        .getMap(NODES_KEY)
        .set('old', { id: 'old', 'x-whiteboard': {} })
      base.commit()
      return base
    }

    it('lets a delete through, which is the repair', () => {
      const base = held(record())
      const update = updateFrom(base, (_d, h) => h.getMap(NODES_KEY).delete('old'))

      expect(judged(base, update)).toBeNull()
    })

    it('lets an edit through that adds none to a document holding one', () => {
      const base = held(record())
      const update = updateFrom(base, (_d, h) =>
        h.getMap(NODES_KEY).set('n1', { id: 'n1', text: 'edited' }),
      )

      expect(judged(base, update)).toBeNull()
    })

    it('refuses one update that writes a new shape while repairing another', () => {
      const base = held(record())
      const update = updateFrom(base, (_d, h) => {
        h.getMap(NODES_KEY).delete('old')
        h.getMap(NODES_KEY).set('fresh', { id: 'fresh', 'x-whiteboard': {} })
      })

      expect(judged(base, update)).toMatchObject({ shape: 'retired-shape' })
    })

    it('lets a snapshot through that replays a shape the document holds', () => {
      const base = held(record())
      const peer = base.fork()
      documentContainers(peer, BOARD).getMap(NODES_KEY).set('n1', { id: 'n1', text: 'moved' })
      peer.commit()

      const breach = importWithinTextLimits(base.fork(), peer.export({ mode: 'snapshot' })).breach

      expect(breach).toBeNull()
    })

    it('refuses the same snapshot into an empty document, where every held shape is new', () => {
      const base = held(record())

      const breach = importWithinTextLimits(new LoroDoc(), base.export({ mode: 'snapshot' })).breach

      expect(breach).toMatchObject({ shape: 'retired-shape', container: expect.any(String) })
    })

    it('refuses a state held by a carried version, as a state', () => {
      const base = held(record())

      expect(judgeStateWithinTextLimits(base)).toMatchObject({ shape: 'retired-shape' })
    })

    it('lets a document with an entry already in the elements list take another edit', () => {
      const base = record()
      elementsOf(base, BOARD).push({ id: 'old' })
      base.commit()
      const update = updateFrom(base, (_d, h) =>
        h.getMap(NODES_KEY).set('n1', { id: 'n1', text: 'edited' }),
      )

      expect(judged(base, update)).toBeNull()
      expect(
        judged(
          base,
          updateFrom(base, (d) => elementsOf(d, BOARD).push({ id: 'more' })),
        ),
      ).toMatchObject({ shape: 'retired-shape' })
    })
  })

  describe('what only looks like one', () => {
    it('lets an okf-body node through on a document whose envelope says spatial', () => {
      const base = record()
      const update = updateFrom(base, (_d, h) => {
        h.getMap(DOCUMENT_KEY).set('kind', 'spatial')
        h.getMap(NODES_KEY).set('okf-body', { id: 'okf-body', text: 'x' })
      })

      expect(judged(base, update)).toBeNull()
    })

    it('lets an okf-body node through on a node whose meta says spatial and no envelope', () => {
      const base = record()
      const update = updateFrom(base, (_d, h) =>
        h.getMap(NODES_KEY).set('okf-body', { id: 'okf-body', text: 'x' }),
      )

      expect(judged(base, update)).toBeNull()
    })

    it('lets an okf-body node through that lands beside a body with text', () => {
      const base = record()
      documentContainers(base, NOTE).getText('body').insert(0, 'hello')
      base.commit()
      const update = updateFrom(
        base,
        (_d, h) => h.getMap(NODES_KEY).set('okf-body', { id: 'okf-body', text: 'x' }),
        NOTE,
      )
      // The note holds "hello", so the body is current whatever else sits beside it.
      expect(judged(base, update)).toBeNull()
    })

    it('lets a type key through inside a thread value', () => {
      const base = record()
      const update = updateFrom(base, (_d, h) =>
        h.getMap(THREADS_KEY).set('t1', { type: 'text', note: 'a thread' }),
      )

      expect(judged(base, update)).toBeNull()
    })

    it('lets a message that spells comments through', () => {
      const base = record()
      const update = updateFrom(
        base,
        (_d, h) => h.getText('body').insert(0, 'see comments and elements and x-whiteboard '),
        NOTE,
      )
      expect(update.byteLength).toBeGreaterThan(1024)

      expect(judged(base, update)).toBeNull()
    })
  })

  describe('on the browser keeper’s fast path', () => {
    it('refuses a short write naming x-whiteboard', () => {
      const base = record()
      const update = updateFrom(
        base,
        (_d, h) => h.getMap(NODES_KEY).set('n2', { 'x-whiteboard': 1 }),
        BOARD,
        true,
      )

      expect(update.byteLength).toBeLessThanOrEqual(1024)
      expect(syncTextLimitJudge(base)(update)).toMatchObject({ shape: 'retired-shape' })
    })

    it('answers a short edit naming none of the retired keys without a copy', () => {
      const base = record()
      const fork = vi.spyOn(base, 'fork')
      const update = updateFrom(
        base,
        (_d, h) => h.getMap(THREADS_KEY).set('t1', { type: 'text', note: 'a thread' }),
        BOARD,
        true,
      )
      fork.mockClear()

      expect(update.byteLength).toBeLessThanOrEqual(1024)
      expect(syncTextLimitJudge(base)(update)).toBeNull()
      expect(fork).not.toHaveBeenCalled()
    })

    it('judges a short text that spells a retired key in full and lets it through', () => {
      const base = record()
      const update = updateFrom(
        base,
        (_d, h) => h.getText('body').insert(0, 'see comments'),
        NOTE,
        true,
      )
      const fork = vi.spyOn(base, 'fork')

      expect(update.byteLength).toBeLessThanOrEqual(1024)
      expect(syncTextLimitJudge(base)(update)).toBeNull()
      expect(fork).toHaveBeenCalledTimes(1)
    })
  })
})

describe('judging for retired shapes opens nothing', () => {
  const plain = (base: LoroDoc, update: Uint8Array) => {
    const copy = base.fork()
    copy.import(update)
    return copy
  }

  it.each([
    [
      'a tree node',
      () => record(),
      (base: LoroDoc) =>
        updateFrom(
          base,
          (_d, h) => h.getMap(NODES_KEY).set('n2', { id: 'n2', text: 'fine' }),
          NOTE,
        ),
    ],
    [
      'a document root',
      () => {
        const doc = new LoroDoc()
        doc.getMap(NODES_KEY).set('n1', { id: 'n1' })
        doc.commit()
        return doc
      },
      (base: LoroDoc) => {
        const client = base.fork()
        const from = client.oplogVersion()
        client.getMap(NODES_KEY).set('okf-body', { id: 'okf-body', text: 'x' })
        client.getMap(DOCUMENT_KEY).set('kind', 'spatial')
        client.commit()
        return client.export({ mode: 'update', from })
      },
    ],
  ])('leaves the judged record as a plain import does, for %s', (_host, make, edit) => {
    const base = make()
    const update = edit(base)
    const judgedCopy = base.fork()

    expect(importWithinTextLimits(judgedCopy, update).breach).toBeNull()

    const expected = plain(base, update)
    expect(judgedCopy.export({ mode: 'update' })).toEqual(expected.export({ mode: 'update' }))
    expect(Object.keys(judgedCopy.getShallowValue())).toEqual(
      Object.keys(expected.getShallowValue()),
    )
    expect(judgedCopy.frontiers()).toEqual(expected.frontiers())
  })

  it('leaves the browser keeper’s record byte-identical after accepting', () => {
    const base = record()
    const before = base.export({ mode: 'update' })
    const update = updateFrom(
      base,
      (_d, h) => h.getMap(NODES_KEY).set('n2', { id: 'n2', text: 'x'.repeat(1_500) }),
      NOTE,
    )

    expect(syncTextLimitJudge(base)(update)).toBeNull()

    expect(base.export({ mode: 'update' })).toEqual(before)
  })

  it('opens no body for a note whose okf-body write is judged', () => {
    const base = record()
    const update = updateFrom(
      base,
      (_d, h) => h.getMap(NODES_KEY).set('okf-body', { id: 'okf-body', text: 'x' }),
      NOTE,
    )
    const judgedCopy = base.fork()

    importWithinTextLimits(judgedCopy, update)

    const expected = plain(base, update)
    expect(judgedCopy.export({ mode: 'update' })).toEqual(expected.export({ mode: 'update' }))
  })
})
