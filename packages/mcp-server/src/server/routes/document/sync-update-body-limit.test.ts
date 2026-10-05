/**
 * The markdown size limit on the editor's sync routes, over the real router
 * and a real store.
 *
 * These routes carry Loro bytes rather than a `markdown` string, so the
 * schema that bounds the JSON writers cannot see them. A write that would
 * leave a body past `MARKDOWN_MAX_CHARS` answers 413 `markdown_too_large`, and
 * what the next read finds is what was stored before it.
 */
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  readMarkdownBody,
  readWorkspaceDocuments,
} from '@kamiazya/whiteboard-loro-adapter'
import { MARKDOWN_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { LoroDoc, type LoroText } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import { testDocumentRouterOptions, withTempDataDir } from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-sync-body-limit-')

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { resolveTestServerDeps, seedWorkspaceRow } = await import('../_test-helpers.js')
const { createDocumentRouter } = await import('../document.js')
// Pre-load ws.js, mirroring the other route tests' documented cycle
// workaround for document.ts's dynamic import.
await import('../../sync-audience.js')

const WS = 'limit-ws'
const DOC_ID = '01BRWAAAAAAAAAAAAAAAAAAAA0'

/**
 * `length` characters, written as separate prepended pieces so the seed is
 * never one long insert: one long insert is the thing the limit refuses, and
 * what costs a second of the engine's time.
 */
function fill(text: LoroText, length: number): void {
  const piece = 8192
  for (let written = 0; written < length; written += piece) {
    text.insert(0, 'w'.repeat(Math.min(piece, length - written)))
  }
}

async function setup() {
  await seedWorkspaceRow(tmp.dir, WS)
  const deps = await resolveTestServerDeps(tmp.dir)
  const app = createDocumentRouter(
    testDocumentRouterOptions({ serverDeps: deps, autoVersionQuietMs: 60_000 }),
  )
  const post = (path: string, body: Uint8Array | string, json = false) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': json ? 'application/json' : 'application/octet-stream' },
      body: body as BodyInit,
    })
  const snapshot = async (path: string): Promise<LoroDoc> => {
    const res = await app.request(path)
    expect(res.status).toBe(200)
    return LoroDoc.fromSnapshot(new Uint8Array(await res.arrayBuffer()))
  }
  return { post, snapshot }
}

/** What a client holding `base` sends after `edit`. */
function updateFrom(base: LoroDoc, edit: (doc: LoroDoc) => void): Uint8Array {
  const client = base.fork()
  const from = client.oplogVersion()
  edit(client)
  client.commit()
  return client.export({ mode: 'update', from })
}

describe('an editor sync write past the markdown size limit', () => {
  it('on the workspace-document route answers 413 and the stored body is unchanged', async () => {
    const { post, snapshot } = await setup()
    const url = `/api/w/${WS}/workspace-document`
    const seeded = updateFrom(await snapshot(`${url}/snapshot`), (doc) => {
      createWorkspaceDocumentAtPath(doc, { path: 'notes', documentId: DOC_ID, kind: 'markdown' })
      fill(documentContainers(doc, DOC_ID).getText('body'), MARKDOWN_MAX_CHARS)
    })
    expect((await post(`${url}/update`, seeded)).status).toBe(200)

    const grow = updateFrom(await snapshot(`${url}/snapshot`), (doc) =>
      documentContainers(doc, DOC_ID).getText('body').insert(0, 'one more'),
    )
    const refused = await post(`${url}/update`, grow)

    expect(refused.status).toBe(413)
    expect(await refused.json()).toMatchObject({ error: 'markdown_too_large' })
    const stored = await snapshot(`${url}/snapshot`)
    expect(readMarkdownBody(documentContainers(stored, DOC_ID))).toHaveLength(MARKDOWN_MAX_CHARS)
  })

  it('on the per-document route answers 413 and the stored body is unchanged', async () => {
    const { post, snapshot } = await setup()
    const url = `/api/w/${WS}/document/notes`
    const seeded = updateFrom(new LoroDoc(), (doc) => fill(doc.getText('body'), MARKDOWN_MAX_CHARS))
    expect((await post(`${url}/update`, seeded)).status).toBe(200)

    const refused = await post(
      `${url}/update`,
      updateFrom(await snapshot(`${url}/snapshot`), (doc) => doc.getText('body').insert(0, '!')),
    )

    expect(refused.status).toBe(413)
    expect(await refused.json()).toMatchObject({ error: 'markdown_too_large' })
    expect(readMarkdownBody(await snapshot(`${url}/snapshot`))).toHaveLength(MARKDOWN_MAX_CHARS)
  })

  it('on the promote route answers 413 and nothing of the record is merged', async () => {
    const { post, snapshot } = await setup()
    const record = new LoroDoc()
    createWorkspaceDocumentAtPath(record, { path: 'big', documentId: DOC_ID, kind: 'markdown' })
    fill(documentContainers(record, DOC_ID).getText('body'), MARKDOWN_MAX_CHARS + 1)
    record.commit()

    const refused = await post(
      `/api/w/${WS}/workspace-document/promote`,
      JSON.stringify({
        snapshot: Buffer.from(record.export({ mode: 'snapshot' })).toString('base64url'),
      }),
      true,
    )

    expect(refused.status).toBe(413)
    expect(await refused.json()).toMatchObject({ error: 'markdown_too_large' })
    const stored = await snapshot(`/api/w/${WS}/workspace-document/snapshot`)
    expect(readWorkspaceDocuments(stored)).toEqual([])
  })
})

describe('a promoted record holding a path outside the document-path grammar', () => {
  it('answers 400 invalid_path naming it and merges nothing', async () => {
    const { post, snapshot } = await setup()
    const record = new LoroDoc()
    createWorkspaceDocumentAtPath(record, {
      path: 'Meeting notes',
      documentId: DOC_ID,
      kind: 'markdown',
    })
    record.commit()

    const refused = await post(
      `/api/w/${WS}/workspace-document/promote`,
      JSON.stringify({
        snapshot: Buffer.from(record.export({ mode: 'snapshot' })).toString('base64url'),
      }),
      true,
    )

    expect(refused.status).toBe(400)
    const body = (await refused.json()) as { error: string; message: string }
    expect(body.error).toBe('invalid_path')
    expect(body.message).toContain('"Meeting notes"')
    const stored = await snapshot(`/api/w/${WS}/workspace-document/snapshot`)
    expect(readWorkspaceDocuments(stored)).toEqual([])
  })
})
