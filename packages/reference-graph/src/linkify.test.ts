import {
  MARKDOWN_BODY_KEY,
  readSpatialCanvas,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { nodeText, type SpatialCanvas, spatialCanvasSchema } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { linkifyMentionsIn, linkMarkupFor } from './linkify.js'

const TARGET = { documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', path: 'redis', name: 'Redis' }

describe('linkifyMentionsIn', () => {
  it('links every unlinked mention in a markdown body and leaves existing links alone', () => {
    const doc = new LoroDoc()
    writeMarkdownBody(doc, 'Redis is fast. See [[redis|Redis]]. Redis again.')

    expect(linkifyMentionsIn(doc, 'markdown', TARGET)).toBe(2)
    expect(doc.getText(MARKDOWN_BODY_KEY).toString()).toBe(
      '[[redis|Redis]] is fast. See [[redis|Redis]]. [[redis|Redis]] again.',
    )
  })

  it('writes nothing, and commits nothing, when there is nothing to link', () => {
    const doc = new LoroDoc()
    writeMarkdownBody(doc, 'Nothing here.')
    const before = doc.oplogVersion().encode()

    expect(linkifyMentionsIn(doc, 'markdown', TARGET)).toBe(0)
    expect(doc.oplogVersion().encode()).toEqual(before)
  })

  // The canvas write is a full resync: whatever it is not handed, it deletes.
  it("rewrites a board's text nodes and keeps its lines, tags and labels", () => {
    const doc = new LoroDoc()
    const board: SpatialCanvas = spatialCanvasSchema.parse({
      nodes: [
        textNode({ id: 'a', x: 0, y: 0, width: 100, height: 40, text: 'we use Redis' }),
        textNode({ id: 'b', x: 200, y: 0, width: 100, height: 40, text: 'B' }),
      ],
      edges: [{ id: 'e', from: { node: 'a' }, to: { node: 'b' }, label: 'Redis link' }],
      lines: [
        {
          id: 'l1',
          from: { kind: 'point', point: { x: 0, y: 0 } },
          to: { kind: 'point', point: { x: 9, y: 9 } },
        },
      ],
      tags: ['architecture'],
    })
    writeSpatialCanvas(doc, board)

    expect(linkifyMentionsIn(doc, 'spatial', TARGET)).toBe(1)
    const canvas = readSpatialCanvas(doc)
    expect(nodeText(canvas.nodes.find((n) => n.id === 'a') ?? canvas.nodes[0]!)).toBe(
      'we use [[redis|Redis]]',
    )
    expect(canvas.edges[0]?.label).toBe('Redis link')
    expect(canvas.lines?.map((line) => line.id)).toEqual(['l1'])
    expect(canvas.tags).toEqual(['architecture'])
  })

  // A newer client's record fails this build's strict schema, so the reader
  // skips it; writing the canvas back must not delete what it skipped, because
  // the deletion is an op that ships to every replica.
  it('leaves a node, edge and line this build cannot read where they are stored', () => {
    const doc = new LoroDoc()
    writeSpatialCanvas(doc, {
      nodes: [
        textNode({ id: 'a', x: 0, y: 0, width: 100, height: 40, text: 'we use Redis' }),
        textNode({ id: 'b', x: 200, y: 0, width: 100, height: 40, text: 'B' }),
      ],
      edges: [],
    })
    doc.getMap('nodes').set('future-node', {
      ...textNode({ id: 'future-node', x: 9, y: 9, width: 10, height: 10, text: 'later' }),
      fieldFromTheFuture: 1,
    })
    doc.getMap('edges').set('future-edge', {
      id: 'future-edge',
      from: { node: 'a' },
      to: { node: 'b' },
      fieldFromTheFuture: 1,
    })
    doc.getMap('lines').set('future-line', {
      id: 'future-line',
      from: { kind: 'point', point: { x: 0, y: 0 } },
      to: { kind: 'point', point: { x: 1, y: 1 } },
      fieldFromTheFuture: 1,
    })
    doc.commit()
    // The subject is present: the reader must really be skipping these.
    expect(readSpatialCanvas(doc).nodes.map((n) => n.id)).toEqual(['a', 'b'])

    expect(linkifyMentionsIn(doc, 'spatial', TARGET)).toBe(1)

    expect(Object.keys(doc.getMap('nodes').toJSON())).toContain('future-node')
    expect(Object.keys(doc.getMap('edges').toJSON())).toEqual(['future-edge'])
    expect(Object.keys(doc.getMap('lines').toJSON())).toEqual(['future-line'])
  })
})

describe('linkMarkupFor', () => {
  it('spells a link by path, and by id when the path would read as an id', () => {
    expect(linkMarkupFor(TARGET)).toBe('[[redis|Redis]]')
    expect(linkMarkupFor({ ...TARGET, path: '01BX5ZZKBKACTAV9WEVGEMMVRZ' })).toBe(
      '[[01ARZ3NDEKTSV4RRFFQ69G5FAV|Redis]]',
    )
  })
})
