import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { withDocumentBatch } from './document-batch.js'
import { readSpatialCanvas, writeSpatialCanvas } from './loro-bridge.js'
import { readMarkdownBody } from './markdown-body.js'

const A = textNode({ id: 'a', text: 'alpha', x: 0, y: 0, width: 10, height: 10 })
const B = textNode({ id: 'b', text: 'beta', x: 50, y: 0, width: 10, height: 10 })

/** A record a newer client wrote: valid there, refused by this build's strict schema. */
function plantUnreadable(doc: LoroDoc): void {
  doc.getMap('nodes').set('future-node', { ...A, id: 'future-node', fieldFromTheFuture: 1 })
  doc.commit()
}

const nodeIds = (doc: LoroDoc) => Object.keys(doc.getMap('nodes').toJSON()).sort()

/** Local-update payloads `fn` produced: one per commit, as a transport would see them. */
async function payloadsFrom(doc: LoroDoc, fn: () => void): Promise<number> {
  let count = 0
  const stop = doc.subscribeLocalUpdates(() => {
    count += 1
  })
  fn()
  // Loro delivers local updates on a later microtask than the commit.
  await new Promise((resolve) => setTimeout(resolve, 0))
  stop()
  return count
}

function seeded(): { doc: LoroDoc; prev: ReturnType<typeof readSpatialCanvas> } {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, { nodes: [A, B], edges: [] })
  plantUnreadable(doc)
  return { doc, prev: readSpatialCanvas(doc) }
}

describe('withDocumentBatch reconcileSpatialCanvas', () => {
  it('writes what changed and leaves a record the schema cannot read', () => {
    const { doc, prev } = seeded()

    withDocumentBatch(doc, (writer) => {
      writer.reconcileSpatialCanvas(prev, { ...prev, nodes: [{ ...A, x: 99 }] })
    })

    expect(nodeIds(doc)).toEqual(['a', 'future-node'])
    expect(readSpatialCanvas(doc).nodes.find((n) => n.id === 'a')?.x).toBe(99)
  })

  it('shares one commit with the other writes of the batch', async () => {
    const { doc, prev } = seeded()

    const payloads = await payloadsFrom(doc, () =>
      withDocumentBatch(doc, (writer) => {
        writer.reconcileSpatialCanvas(prev, { ...prev, nodes: [{ ...A, x: 99 }, B] })
        writer.writeMarkdownBody('body')
      }),
    )

    expect(readMarkdownBody(doc)).toBe('body')
    expect(payloads).toBe(1)
  })

  it('commits nothing for a canvas that did not change', async () => {
    const { doc, prev } = seeded()

    const payloads = await payloadsFrom(doc, () =>
      withDocumentBatch(doc, (writer) => {
        writer.reconcileSpatialCanvas(prev, { ...prev })
      }),
    )

    expect(payloads).toBe(0)
  })
})
