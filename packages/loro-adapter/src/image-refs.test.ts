import type { ProposedChange, ProposedChangeStatus } from '@kamiazya/whiteboard-model'
import { fileNode, groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { collectImageRefIds } from './image-refs.js'
import { writeSpatialCanvas } from './loro-bridge.js'
import { writeProposal } from './proposals.js'

function seed(files: string[]): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: [
      textNode({ id: 'n-text', x: 0, y: 0, width: 100, height: 40, text: 'no ref' }),
      ...files.map((file, i) =>
        fileNode({ id: `n-file-${i}`, x: 0, y: (i + 1) * 50, width: 100, height: 40, file }),
      ),
    ],
    edges: [],
  })
  return doc
}

describe('collectImageRefIds', () => {
  it('collects the id of every asset-prefixed file node, and nothing else', () => {
    const doc = seed(['asset:01ARZ3NDEKTSV4RRFFQ69G5FC1', 'plain/path.png'])
    expect(collectImageRefIds(doc)).toEqual(new Set(['01ARZ3NDEKTSV4RRFFQ69G5FC1']))
  })

  it('two nodes referencing the same asset yield one id', () => {
    const doc = seed(['asset:01ARZ3NDEKTSV4RRFFQ69G5FC1', 'asset:01ARZ3NDEKTSV4RRFFQ69G5FC1'])
    expect(collectImageRefIds(doc).size).toBe(1)
  })

  it('a canvas with no file nodes yields an empty set', () => {
    expect(collectImageRefIds(seed([]))).toEqual(new Set())
  })

  it('also collects a frame background and an inline image in a text node', () => {
    const doc = new LoroDoc()
    writeSpatialCanvas(doc, {
      nodes: [
        groupNode({
          id: 'g',
          x: 0,
          y: 0,
          width: 300,
          height: 200,
          label: 'F',
          background: 'asset:bg',
        }),
        textNode({ id: 't', x: 0, y: 0, width: 100, height: 40, text: '![x](asset:inline)' }),
      ],
      edges: [],
    })
    expect(collectImageRefIds(doc)).toEqual(new Set(['bg', 'inline']))
  })

  it("collects an inline image in a markdown document's body", () => {
    const doc = new LoroDoc()
    doc.getText('body').insert(0, 'see ![p](asset:md-1)')
    doc.commit()
    expect(collectImageRefIds(doc)).toEqual(new Set(['md-1']))
  })

  describe('an undecided proposal', () => {
    // Each change is the only thing in the document naming its image.
    const CHANGES: Record<string, (status: ProposedChangeStatus) => ProposedChange> = {
      'a proposed file node': (status) => ({
        id: 'c-add',
        status,
        op: 'node.add',
        node: fileNode({ id: 'n-add', x: 0, y: 0, width: 9, height: 9, file: 'asset:added' }),
      }),
      "a patch to a node's file": (status) => ({
        id: 'c-file',
        status,
        op: 'node.patch',
        nodeId: 'n-text',
        patch: { file: 'asset:patched' },
        assumed: {},
      }),
      "a patch to a frame's background": (status) => ({
        id: 'c-bg',
        status,
        op: 'node.patch',
        nodeId: 'n-text',
        patch: { background: 'asset:backdrop' },
        assumed: {},
      }),
      "a patch to a node's text": (status) => ({
        id: 'c-text',
        status,
        op: 'node.patch',
        nodeId: 'n-text',
        patch: { text: 'see ![p](asset:in-text)' },
        assumed: {},
      }),
      'a replacement passage': (status) => ({
        id: 'c-body',
        status,
        op: 'body.replace',
        anchor: { kind: 'text', quote: { exact: 'x' }, start: 0, end: 1 },
        text: '![p](<asset:in-passage>)',
        assumed: 'x',
      }),
    }
    const EXPECTED: Record<string, string> = {
      'a proposed file node': 'added',
      "a patch to a node's file": 'patched',
      "a patch to a frame's background": 'backdrop',
      "a patch to a node's text": 'in-text',
      'a replacement passage': 'in-passage',
    }

    function proposing(change: ProposedChange): LoroDoc {
      const doc = seed([])
      writeProposal(doc, { id: 'p1', changes: [change] })
      return doc
    }

    it.each(Object.keys(CHANGES))('keeps what %s names while it is open', (name) => {
      const doc = proposing(CHANGES[name]!('open'))
      expect(collectImageRefIds(doc)).toEqual(new Set([EXPECTED[name]]))
    })

    // A decided change names nothing a later adoption could draw: an adopted
    // one's result is already in the content, a dismissed one is gone.
    it.each(Object.keys(CHANGES))('drops what %s names once it is decided', (name) => {
      for (const status of ['adopted', 'dismissed'] as const) {
        expect(collectImageRefIds(proposing(CHANGES[name]!(status))), status).toEqual(new Set())
      }
    })
  })
})
