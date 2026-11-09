import { type OkfCodecCore, parseOkf, serializeOkf } from '@kamiazya/whiteboard-codec'

type OkfCore = OkfCodecCore['okf']

import { readMarkdownBody, writeMarkdownBody } from '@kamiazya/whiteboard-loro-adapter'
import { reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import { InMemoryDocumentStore } from '@kamiazya/whiteboard-ports/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { ServerDeps } from '../server-deps.js'
import {
  FakeDocumentStore,
  placeUnlessPlaced,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { wbDocumentCreate } from './document-crud.js'
import { createDocumentSetOperation, OkfParseError } from './document-set.js'
import { exportOkf } from './export-okf.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = '01ZVM89A4A1V9FS03Z9J64KEK1'

/** A core that answers as the TypeScript does, with one call replaced, switched to `rust`. */
function rustCore(overrides: Partial<OkfCore>): () => Promise<OkfCodecCore> {
  const okf: OkfCore = { parseOkf, serializeOkf, ...overrides }
  return async () => ({ okf, impl: { parseOkf: 'rust', serializeOkf: 'rust' } })
}

async function storedBody(store: FakeDocumentStore): Promise<string | undefined> {
  const snap = await store.loadSnapshot({
    docRef: { kind: 'document', workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID },
  })
  if (!snap) throw new Error('no snapshot')
  const doc = new LoroDoc()
  doc.import(reassembleSnapshot(snap.manifest, snap.chunks))
  return readMarkdownBody(doc)
}

describe('ServerDeps.okfCore reaches every OKF reader and writer', () => {
  it('document.set stores the document the core read', async () => {
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
    const deps: ServerDeps = makeTestDeps({
      documentStore: store,
      documentIndex: store.documentIndex,
      okfCore: rustCore({
        parseOkf: () => ({
          ok: true,
          value: { frontmatter: { type: 'note' }, body: 'read by the core' },
        }),
      }),
    })

    await createDocumentSetOperation(deps).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      markdown: '---\ntype: note\n---\nwritten by the caller',
    })

    expect(await storedBody(store)).toBe('read by the core')
  })

  it('document.create refuses a body the core refuses', async () => {
    const deps = makeTestDeps({
      documentStore: new InMemoryDocumentStore(),
      okfCore: rustCore({
        parseOkf: () => ({
          ok: false,
          error: { stage: 'frontmatter-schema', message: 'refused by the core', issues: [] },
        }),
      }),
    })

    await expect(
      wbDocumentCreate(deps, {
        workspaceId: WORKSPACE_ID,
        path: 'x',
        kind: 'markdown',
        markdown: '---\ntype: note\n---\nfine',
      }),
    ).rejects.toThrow(OkfParseError)
  })

  it('the OKF export answers with the text the core wrote', async () => {
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, (doc) => writeMarkdownBody(doc, 'hello'))
    await placeUnlessPlaced(store, WORKSPACE_ID, DOCUMENT_ID)
    const deps = makeTestDeps({
      documentStore: store,
      documentIndex: store.documentIndex,
      okfCore: rustCore({ serializeOkf: () => 'written by the core' }),
    })

    const result = await exportOkf(deps, { workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID })

    expect(result.markdown).toBe('written by the core')
  })
})
