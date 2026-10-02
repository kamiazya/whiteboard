import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import type { Attestation } from '../versions/version-entry.js'
import { FakeVersionHistory } from './fake-version-history.js'

function docWithNodes(count: number): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: Array.from({ length: count }, (_, index) =>
      textNode({ id: `n${index}`, x: 0, y: 0, width: 10, height: 10, text: 't' }),
    ),
    edges: [],
  })
  return doc
}

const ATTESTATION: Attestation = {
  kind: 'webauthn',
  credentialId: 'Y3JlZA',
  authenticatorData: 'YXV0aA',
  clientDataJSON: 'Y2xpZW50',
  signature: 'c2ln',
}

describe('FakeVersionHistory', () => {
  test('a saved row carries the live element count and the attestation it was given', async () => {
    const history = new FakeVersionHistory()

    const entry = await history.save('ws', 'notes/plan', docWithNodes(3), {
      auto: false,
      attestation: ATTESTATION,
    })

    expect(entry.elementCount).toBe(3)
    expect(entry.attestation).toEqual(ATTESTATION)
    expect(await history.list('ws', 'notes/plan')).toEqual([entry])
  })

  test('records what each save asked for and reloads the doc as it was saved', async () => {
    const history = new FakeVersionHistory()
    const doc = docWithNodes(1)

    const entry = await history.save('ws', 'a', doc, { auto: true, label: 'first' })
    writeSpatialCanvas(doc, { nodes: [], edges: [] })

    expect(history.saves).toEqual([{ path: 'a', options: { auto: true, label: 'first' } }])
    const loaded = await history.load('ws', entry.id)
    expect(loaded?.export({ mode: 'snapshot' })).not.toEqual(doc.export({ mode: 'snapshot' }))
  })
})
