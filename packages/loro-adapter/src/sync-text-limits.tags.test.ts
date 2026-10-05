import { type SpatialCanvas, TAG_MAX_CHARS, TAGS_PER_ELEMENT_MAX } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { CANVAS_KEY, CANVAS_TAGS_FIELD, type DocumentContainers } from './containers.js'
import { writeSpatialCanvas, writeSpatialEdge, writeSpatialNode } from './loro-bridge.js'
import {
  importWithinTextLimits,
  SYNC_TEXT_BREACH_CODES,
  syncTextLimitJudge,
} from './sync-text-limits.js'
import { createWorkspaceDocumentAtPath, documentContainers } from './workspace-tree.js'

const DOC_ID = '01BRWAAAAAAAAAAAAAAAAAAAA0'

const tagsOf = (count: number) => Array.from({ length: count }, (_, i) => `t${i}`)
const box = (id: string, x: number, tags?: string[]) => ({
  ...textNode({ id, x, y: 0, width: 200, height: 60, text: id }),
  ...(tags !== undefined && { tags }),
})
const edge = (tags?: string[]) => ({
  id: 'e',
  from: { node: 'a' },
  to: { node: 'b' },
  ...(tags !== undefined && { tags }),
})

/** A workspace record holding one board: two boxes and an edge between them. */
function record(stored: { node?: string[]; edge?: string[]; board?: string[] } = {}): LoroDoc {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: 'board', documentId: DOC_ID, kind: 'spatial' })
  const canvas = {
    nodes: [box('a', 0, stored.node), box('b', 300)],
    edges: [edge(stored.edge)],
    ...(stored.board !== undefined && { tags: stored.board }),
  } as SpatialCanvas
  writeSpatialCanvas(documentContainers(doc, DOC_ID), canvas)
  doc.commit()
  return doc
}

function updateFrom(base: LoroDoc, edit: (board: DocumentContainers) => void): Uint8Array {
  const client = base.fork()
  const from = client.oplogVersion()
  edit(documentContainers(client, DOC_ID))
  client.commit()
  return client.export({ mode: 'update', from })
}

/** Both keepers' verdicts, which must agree. */
function judged(base: LoroDoc, update: Uint8Array) {
  const imported = importWithinTextLimits(base.fork(), update).breach
  expect(syncTextLimitJudge(base)(update)).toEqual(imported)
  return imported
}

const tagNode = (tags: string[]) => (board: DocumentContainers) =>
  writeSpatialNode(board, box('a', 0, tags) as SpatialCanvas['nodes'][number])
const tagEdge = (tags: string[]) => (board: DocumentContainers) =>
  writeSpatialEdge(board, edge(tags) as SpatialCanvas['edges'][number])
const tagBoard = (tags: string[]) => (board: DocumentContainers) =>
  board.getMap(CANVAS_KEY).set(CANVAS_TAGS_FIELD, tags)

describe('tags written through a sync update', () => {
  it.each([
    ['a node', tagNode, 'a'],
    ['an edge', tagEdge, 'e'],
    ['the board', tagBoard, null],
  ] as const)('refuses %s carrying more tags than one element may', (_, write, elementId) => {
    const base = record()
    expect(judged(base, updateFrom(base, write(tagsOf(TAGS_PER_ELEMENT_MAX + 1))))).toEqual({
      shape: 'tags',
      measure: 'count',
      amount: TAGS_PER_ELEMENT_MAX + 1,
      elementId,
      container: expect.any(String),
    })
  })

  it.each([
    ['a node', tagNode, 'a'],
    ['an edge', tagEdge, 'e'],
    ['the board', tagBoard, null],
  ] as const)('refuses %s carrying a tag longer than one may be', (_, write, elementId) => {
    const base = record()
    const update = updateFrom(base, write(['ok', 'a'.repeat(TAG_MAX_CHARS + 1)]))
    expect(judged(base, update)).toEqual({
      shape: 'tags',
      measure: 'chars',
      amount: TAG_MAX_CHARS + 1,
      elementId,
      container: expect.any(String),
    })
  })

  it('takes a set at exactly both bounds', () => {
    const base = record()
    const atBounds = [...tagsOf(TAGS_PER_ELEMENT_MAX - 1), 'a'.repeat(TAG_MAX_CHARS)]
    expect(judged(base, updateFrom(base, tagNode(atBounds)))).toBeNull()
    expect(judged(base, updateFrom(base, tagBoard(atBounds)))).toBeNull()
  })

  it('takes an edit of a set stored past both bounds that does not grow it', () => {
    const stored = [...tagsOf(TAGS_PER_ELEMENT_MAX + 10), 'a'.repeat(TAG_MAX_CHARS + 10)]
    const base = record({ node: stored, edge: stored, board: stored })
    const shrunk = stored.slice(1)
    expect(
      judged(
        base,
        updateFrom(base, (board) =>
          writeSpatialNode(board, { ...box('a', 50, stored), color: '1' } as never),
        ),
      ),
    ).toBeNull()
    expect(judged(base, updateFrom(base, tagEdge(shrunk)))).toBeNull()
    expect(judged(base, updateFrom(base, tagBoard(shrunk)))).toBeNull()
  })

  it('judges only the canvas key the board reads its tags from', () => {
    const base = record()
    const update = updateFrom(base, (board) =>
      board.getMap(CANVAS_KEY).set('x-whiteboard', { tags: tagsOf(TAGS_PER_ELEMENT_MAX + 1) }),
    )
    expect(judged(base, update)).toBeNull()
  })

  it('refuses growing a set stored past the bound', () => {
    const stored = tagsOf(TAGS_PER_ELEMENT_MAX + 10)
    const base = record({ node: stored })
    expect(judged(base, updateFrom(base, tagNode([...stored, 'more'])))).toMatchObject({
      shape: 'tags',
      measure: 'count',
      amount: TAGS_PER_ELEMENT_MAX + 11,
    })
  })

  it('refuses tags past a bound that a record holds into an empty document', () => {
    const long = record({ edge: tagsOf(TAGS_PER_ELEMENT_MAX + 1) })
    expect(
      importWithinTextLimits(new LoroDoc(), long.export({ mode: 'snapshot' })).breach,
    ).toMatchObject({ shape: 'tags', measure: 'count', elementId: 'e' })
  })

  it('takes an update whose bytes are at least as many as the tags it writes', () => {
    // The answer the judge gives a short update without applying it rests on
    // this for the count bound too: an encoding that shared repeated strings
    // would let a long list of one tag through.
    const base = record()
    for (const tags of [Array(5_000).fill(''), Array(5_000).fill('x')]) {
      expect(updateFrom(base, tagBoard(tags)).byteLength).toBeGreaterThanOrEqual(tags.length)
    }
  })

  it('answers a tag breach with its own refusal code', () => {
    expect(SYNC_TEXT_BREACH_CODES.tags).toBe('tags_too_large')
  })
})
