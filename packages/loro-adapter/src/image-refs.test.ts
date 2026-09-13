import { fileNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { collectImageRefIds } from './image-refs.js'
import { writeSpatialCanvas } from './loro-bridge.js'

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
})
