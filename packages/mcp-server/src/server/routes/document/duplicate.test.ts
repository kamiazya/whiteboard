/**
 * Duplicate as ONE request: the copy is made by the keeper, beside its
 * source, in one write. The placement and naming rules are the
 * `DocumentDuplicates` conformance suite's; what this file pins is the REACH —
 * the route a person's Duplicate reaches, through the real container deps.
 */

import { duplicateDocumentResponseSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import { documentDuplicateApiUrl } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import {
  readMarkdownBody,
  writeDocumentKind,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { hasDocumentDuplicates } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { testDocumentRouterOptions, withTempDataDir } from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-duplicate-test-')

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { saveDocument, getDoc } = await import('../../store/document-store.js')
const { clearDocCacheForTests } = await import('../../store/doc-cache.js')
const { createDocumentRouter } = await import('../document.js')
const { createContainer, resolveServerDeps } = await import('../../../di/container.js')
const { createSelfHostStoreLocalModule } = await import('../../../di/store-local.module.js')
const { prepareDataDir } = await import('../../store/db/prepare.js')
const { getDb } = await import('../../store/db/index.js')

beforeEach(() => {
  clearDocCacheForTests()
})

const WS = 'ws-duplicate'

function note(body: string): LoroDoc {
  const doc = new LoroDoc()
  writeDocumentKind(doc, 'markdown')
  writeMarkdownBody(doc, body)
  return doc
}

async function appWithRealDeps() {
  await prepareDataDir(tmp.dir)
  const db = await getDb(tmp.dir)
  const deps = resolveServerDeps(createContainer(createSelfHostStoreLocalModule(db, tmp.dir)))
  expect(hasDocumentDuplicates(deps.documentIndex)).toBe(true)
  return createDocumentRouter(testDocumentRouterOptions({ serverDeps: deps }))
}

describe('POST …/documents/<path>/duplicate', () => {
  it('copies a document in a folder to a sibling path, named after it, with its content', async () => {
    await saveDocument(WS, 'notes/roadmap', note('# Roadmap\n\nship it'), { kind: 'markdown' })
    const app = await appWithRealDeps()

    const res = await app.request(documentDuplicateApiUrl(WS, 'notes/roadmap'), {
      method: 'POST',
    })

    expect(res.status).toBe(200)
    const { document } = duplicateDocumentResponseSchema.parse(await res.json())
    expect(document).toMatchObject({ path: 'notes/roadmap-copy', kind: 'markdown' })
    expect(document.name).toBe('notes/roadmap (copy)')
    expect(readMarkdownBody(await getDoc(WS, 'notes/roadmap-copy'))).toBe('# Roadmap\n\nship it')
  })

  it('answers 404 for a path no document holds, and makes nothing', async () => {
    await saveDocument(WS, 'kept', note('kept'), { kind: 'markdown' })
    const app = await appWithRealDeps()

    const res = await app.request(documentDuplicateApiUrl(WS, 'gone'), { method: 'POST' })

    expect(res.status).toBe(404)
    const listed = await app.request(`/api/workspaces/${WS}/documents`)
    const { documents } = (await listed.json()) as { documents: { path: string }[] }
    expect(documents.map((row) => row.path)).toEqual(['kept'])
  })
})
