import {
  countSpatialNodes,
  documentFromSnapshot,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, test } from 'vitest'
import type { Attestation } from '../versions/version-entry.js'
import { FakeDocumentStore, registerDocumentInWorkspace, seedDoc } from './fake-document-store.js'
import { FakeVersionHistory } from './fake-version-history.js'

const WORKSPACE_ID = '01ZVM89A4A1V9FS03Z9J64KEK1'
const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'

/** A history over a store holding one board of `count` nodes at `path`. */
async function historyOver(path: string, count: number) {
  const store = new FakeDocumentStore()
  await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID, path)
  await seedDoc(store, DOCUMENT_ID, (doc) =>
    writeSpatialCanvas(doc, {
      nodes: Array.from({ length: count }, (_, index) =>
        textNode({ id: `n${index}`, x: 0, y: 0, width: 10, height: 10, text: 't' }),
      ),
      edges: [],
    }),
  )
  return { store, history: new FakeVersionHistory(store) }
}

const ATTESTATION: Attestation = {
  kind: 'webauthn',
  credentialId: 'Y3JlZA',
  authenticatorData: 'YXV0aA',
  clientDataJSON: 'Y2xpZW50',
  signature: 'c2ln',
}

describe('FakeVersionHistory', () => {
  test('the port takes no branchName: a keeper has one lane of history', async () => {
    const { history } = await historyOver('notes/plan', 1)

    const entry = await history.save(WORKSPACE_ID, 'notes/plan', {
      auto: false,
      // @ts-expect-error the port's save options no longer name a branch
      branchName: 'wide-layout',
    })

    expect(entry).not.toHaveProperty('branchName')
  })

  test('a saved row carries the stored element count and no attestation', async () => {
    const { history } = await historyOver('notes/plan', 3)

    const entry = await history.save(WORKSPACE_ID, 'notes/plan', {
      auto: false,
      // @ts-expect-error the port's save options take no attestation: no operation collects one
      attestation: ATTESTATION,
    })

    expect(entry.elementCount).toBe(3)
    expect(entry).not.toHaveProperty('attestation')
    expect(await history.list(WORKSPACE_ID, 'notes/plan')).toEqual([entry])
  })

  test('records what each save asked for and reloads the document as it was saved', async () => {
    const { store, history } = await historyOver('a', 1)

    const entry = await history.save(WORKSPACE_ID, 'a', { auto: true, label: 'first' })
    await seedDoc(store, DOCUMENT_ID, (doc) => writeSpatialCanvas(doc, { nodes: [], edges: [] }))

    expect(history.saves).toEqual([{ path: 'a', options: { auto: true, label: 'first' } }])
    const loaded = await history.load(WORKSPACE_ID, entry.id)
    expect(loaded && countSpatialNodes(documentFromSnapshot(loaded))).toBe(1)
  })

  test('with no store, every document is empty', async () => {
    const entry = await new FakeVersionHistory().save(WORKSPACE_ID, 'a', { auto: false })
    expect(entry.elementCount).toBe(0)
  })
})
