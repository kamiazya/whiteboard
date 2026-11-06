/**
 * Duplicate as ONE request: the copy is made by the keeper, beside its
 * source, in one write. The placement and naming rules are the
 * `DocumentDuplicates` conformance suite's; what this file pins is the REACH —
 * the route a person's Duplicate reaches, through the real container deps.
 */

import { duplicateDocumentResponseSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import { documentDuplicateApiUrl } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import {
  readCommentThreads,
  readMarkdownBody,
  writeCommentThread,
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

const WS = '01RVSYAFF984RBYQRQTG8KAZQD'

function note(body: string): LoroDoc {
  const doc = new LoroDoc()
  writeDocumentKind(doc, 'markdown')
  writeMarkdownBody(doc, body)
  return doc
}

function commented(body: string): LoroDoc {
  const doc = note(body)
  writeCommentThread(doc, {
    id: 't1',
    anchor: { kind: 'document' },
    status: 'open',
    messages: [{ id: 'm1', body: 'which release?' }],
  })
  return doc
}

const threadIds = async (path: string): Promise<string[]> =>
  readCommentThreads(await getDoc(WS, path)).map((thread) => thread.id)

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
    expect(document.name).toBe('roadmap (copy)')
    expect(readMarkdownBody(await getDoc(WS, 'notes/roadmap-copy'))).toBe('# Roadmap\n\nship it')
  })

  it('names the copy of an unnamed document at a generated address after its "Untitled 3" label', async () => {
    await saveDocument(WS, 'untitled-3', note('draft'), { kind: 'markdown' })
    const app = await appWithRealDeps()

    const res = await app.request(documentDuplicateApiUrl(WS, 'untitled-3'), { method: 'POST' })

    expect(res.status).toBe(200)
    const { document } = duplicateDocumentResponseSchema.parse(await res.json())
    expect(document).toMatchObject({ path: 'untitled-3-copy', name: 'Untitled 3 (copy)' })
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

  it('answers 409 for a source too deep for a copy beside it, and makes nothing', async () => {
    const folder = Array.from({ length: 6 }, (_, i) => `f${i}${'a'.repeat(167)}`).join('/')
    const deep = `${folder}/b`
    await saveDocument(WS, deep, note('deep'), { kind: 'markdown' })
    const app = await appWithRealDeps()

    const res = await app.request(documentDuplicateApiUrl(WS, deep), { method: 'POST' })

    expect(res.status).toBe(409)
    expect(((await res.json()) as { message: string }).message).toMatch(/no room beside/)
    const listed = await app.request(`/api/workspaces/${WS}/documents`)
    const { documents } = (await listed.json()) as { documents: { path: string }[] }
    expect(documents.map((row) => row.path)).toEqual([deep])
  })

  it('copies the content without its comment threads when asked, and the source keeps them', async () => {
    await saveDocument(WS, 'notes/roadmap', commented('ship it'), { kind: 'markdown' })
    const app = await appWithRealDeps()

    const res = await app.request(documentDuplicateApiUrl(WS, 'notes/roadmap'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ withoutAnnotations: true }),
    })

    expect(res.status).toBe(200)
    const answered = duplicateDocumentResponseSchema.parse(await res.json())
    expect(answered.document).toMatchObject({ path: 'notes/roadmap-copy', name: 'roadmap (copy)' })
    // The echo is how a client tells this daemon from one that never read
    // the body and copied the comments anyway.
    expect(answered.withoutAnnotations).toBe(true)
    expect(readMarkdownBody(await getDoc(WS, 'notes/roadmap-copy'))).toBe('ship it')
    await expect(threadIds('notes/roadmap-copy')).resolves.toEqual([])
    await expect(threadIds('notes/roadmap')).resolves.toEqual(['t1'])
  })

  it('keeps the comment threads in a copy asked for with no body', async () => {
    await saveDocument(WS, 'notes/roadmap', commented('ship it'), { kind: 'markdown' })
    const app = await appWithRealDeps()

    const res = await app.request(documentDuplicateApiUrl(WS, 'notes/roadmap'), { method: 'POST' })

    expect(duplicateDocumentResponseSchema.parse(await res.json())).not.toHaveProperty(
      'withoutAnnotations',
    )
    await expect(threadIds('notes/roadmap-copy')).resolves.toEqual(['t1'])
  })

  it('answers 400 for a body of the wrong shape, and makes nothing', async () => {
    await saveDocument(WS, 'kept', note('kept'), { kind: 'markdown' })
    const app = await appWithRealDeps()

    const res = await app.request(documentDuplicateApiUrl(WS, 'kept'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ withoutAnnotations: 'yes' }),
    })

    expect(res.status).toBe(400)
    const listed = await app.request(`/api/workspaces/${WS}/documents`)
    const { documents } = (await listed.json()) as { documents: { path: string }[] }
    expect(documents.map((row) => row.path)).toEqual(['kept'])
  })
})
