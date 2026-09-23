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
})

describe('linkMarkupFor', () => {
  it('spells a link by path, and by id when the path would read as an id', () => {
    expect(linkMarkupFor(TARGET)).toBe('[[redis|Redis]]')
    expect(linkMarkupFor({ ...TARGET, path: '01BX5ZZKBKACTAV9WEVGEMMVRZ' })).toBe(
      '[[01ARZ3NDEKTSV4RRFFQ69G5FAV|Redis]]',
    )
  })
})
