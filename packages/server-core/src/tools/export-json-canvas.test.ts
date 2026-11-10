import { installSpatialCore, type SpatialCore } from '@kamiazya/whiteboard-codec'
import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { afterEach, describe, expect, test } from 'vitest'
import { ZodError } from 'zod'
import { SnapshotNotFoundError } from '../document-io.js'
import type { ServerDeps } from '../server-deps.js'
import { FakeDocumentStore, placeUnlessPlaced, seedDoc } from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { DocumentSerializeError } from './errors.js'
import { exportJsonCanvas } from './export-json-canvas.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

const NODE_WITH_EXTENSION = textNode({
  id: 'n1',
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  text: 'hi',
  embed: { documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7' as const },
})

/** Places the document under test, since every read tool refuses one its workspace does not hold. */
async function makeDeps(documentStore: FakeDocumentStore): Promise<ServerDeps> {
  await placeUnlessPlaced(documentStore, WORKSPACE_ID, DOCUMENT_ID)
  return makeTestDeps({
    documentStore: documentStore,
    documentIndex: documentStore.documentIndex,
  })
}

describe('exportJsonCanvas', () => {
  test('strict mode drops the x-whiteboard extension key', async () => {
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeSpatialCanvas(doc, { nodes: [NODE_WITH_EXTENSION], edges: [] })
    })
    const result = await exportJsonCanvas(await makeDeps(store), {
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      options: { strict: true },
    })
    const parsed = JSON.parse(result.json)

    expect(parsed.nodes[0]['x-whiteboard']).toBeUndefined()
  })

  test('extended mode (default) round-trips the x-whiteboard extension losslessly', async () => {
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeSpatialCanvas(doc, { nodes: [NODE_WITH_EXTENSION], edges: [] })
    })
    const result = await exportJsonCanvas(await makeDeps(store), {
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
    })
    const parsed = JSON.parse(result.json)

    expect(parsed.nodes[0]['x-whiteboard']).toEqual({
      kind: 'embed',
      documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7',
    })
  })

  test('rejects when the canvas has no stored snapshot', async () => {
    await expect(
      exportJsonCanvas(await makeDeps(new FakeDocumentStore()), {
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
      }),
    ).rejects.toThrow(SnapshotNotFoundError)
  })
})

describe('the realm core writes the JSON Canvas export', () => {
  let real: SpatialCore | undefined
  // The installation is process-global: the realm's core is put back after each test.
  afterEach(() => installSpatialCore(real))

  /** The realm's core with its writer replaced, installed for the test that asks. */
  function replaceWriter(serializeSpatial: SpatialCore['serializeSpatial']): void {
    real = installSpatialCore(undefined)
    if (real === undefined) throw new Error('the test realm installs the core')
    const core = real
    installSpatialCore({ parseSpatial: (text) => core.parseSpatial(text), serializeSpatial })
  }

  async function seeded(): Promise<ServerDeps> {
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeSpatialCanvas(doc, { nodes: [NODE_WITH_EXTENSION], edges: [] })
    })
    return makeDeps(store)
  }

  test('answers with the text the core wrote, in the mode the input names', async () => {
    const modes: string[] = []
    const deps = await seeded()
    replaceWriter((_canvas, mode) => {
      modes.push(mode)
      return 'written by the core'
    })
    const result = await exportJsonCanvas(deps, {
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      options: { strict: true },
    })
    expect(result.json).toBe('written by the core')
    expect(modes).toEqual(['strict'])
  })

  test('reports a canvas the core refuses to write as that document failing to serialise', async () => {
    const deps = await seeded()
    replaceWriter(() => {
      throw new ZodError([{ code: 'custom', path: [], message: 'refused by the core' }])
    })
    await expect(
      exportJsonCanvas(deps, { workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID }),
    ).rejects.toThrow(DocumentSerializeError)
  })

  test('keeps a defect in the writer loud', async () => {
    const deps = await seeded()
    replaceWriter(() => {
      throw new RangeError('a defect')
    })
    await expect(
      exportJsonCanvas(deps, { workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID }),
    ).rejects.toThrow(RangeError)
  })
})
