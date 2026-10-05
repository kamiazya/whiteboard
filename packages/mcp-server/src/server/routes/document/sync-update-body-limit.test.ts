/**
 * The markdown size limit on the editor's sync routes, over the real router
 * and a real store.
 *
 * These routes carry Loro bytes rather than a `markdown` string, so the
 * schema that bounds the JSON writers cannot see them. A write that would
 * leave a body past `MARKDOWN_MAX_CHARS` answers 413 `markdown_too_large`, and
 * what the next read finds is what was stored before it.
 *
 * Every refusal is read through the client's contract for it, so a code the
 * routes answer that the browser cannot name fails here rather than reaching
 * a person as an unexplained refusal.
 */

import { syncWriteRefusalOf } from '@kamiazya/whiteboard-daemon-client/api-contracts/sync-write-refusal'
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  moveWorkspaceNodeToPath,
  readMarkdownBody,
  readSpatialCanvas,
  readWorkspaceDocuments,
  writeCommentThread,
  writeSpatialNode,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  COMMENT_MESSAGE_MAX_CHARS,
  DOCUMENT_NAME_MAX_LENGTH,
  LABEL_MAX_CHARS,
  MARKDOWN_MAX_CHARS,
  NODE_TEXT_MAX_CHARS,
} from '@kamiazya/whiteboard-model'
import { groupNode } from '@kamiazya/whiteboard-model/test-utils'
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
    expect(syncWriteRefusalOf(await refused.json()).code).toBe('markdown_too_large')
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
    expect(syncWriteRefusalOf(await refused.json()).code).toBe('markdown_too_large')
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
    expect(syncWriteRefusalOf(await refused.json()).code).toBe('markdown_too_large')
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
    const body = syncWriteRefusalOf(await refused.json())
    expect(body.code).toBe('invalid_path')
    expect(body.message).toContain('"Meeting notes"')
    const stored = await snapshot(`/api/w/${WS}/workspace-document/snapshot`)
    expect(readWorkspaceDocuments(stored)).toEqual([])
  })
})

describe('a workspace-document update moving a document outside the path grammar', () => {
  it('answers 400 invalid_path naming it and the stored path is unchanged', async () => {
    const { post, snapshot } = await setup()
    const url = `/api/w/${WS}/workspace-document`
    const seeded = updateFrom(await snapshot(`${url}/snapshot`), (doc) =>
      createWorkspaceDocumentAtPath(doc, { path: 'big', documentId: DOC_ID, kind: 'markdown' }),
    )
    expect((await post(`${url}/update`, seeded)).status).toBe(200)

    const refused = await post(
      `${url}/update`,
      updateFrom(await snapshot(`${url}/snapshot`), (doc) => {
        expect(moveWorkspaceNodeToPath(doc, 'big', 'Meeting notes')).toBe(true)
      }),
    )

    expect(refused.status).toBe(400)
    const body = syncWriteRefusalOf(await refused.json())
    expect(body.code).toBe('invalid_path')
    expect(body.message).toContain('"Meeting notes"')
    const stored = await snapshot(`${url}/snapshot`)
    expect(readWorkspaceDocuments(stored).map((entry) => entry.path)).toEqual(['big'])
  })
})

describe('an editor sync write giving a node text past the node limit', () => {
  it('on the per-document route answers 413 node_text_too_large and stores nothing', async () => {
    const { post, snapshot } = await setup()
    const url = `/api/w/${WS}/document/board`
    expect(
      (
        await post(
          `${url}/update`,
          updateFrom(new LoroDoc(), () => {}),
        )
      ).status,
    ).toBe(200)

    const refused = await post(
      `${url}/update`,
      updateFrom(await snapshot(`${url}/snapshot`), (doc) =>
        writeSpatialNode(doc, {
          id: 'big',
          resource: { mimeType: 'text/markdown', content: 'x'.repeat(NODE_TEXT_MAX_CHARS + 1) },
          x: 0,
          y: 0,
          width: 200,
          height: 100,
        }),
      ),
    )

    expect(refused.status).toBe(413)
    expect(syncWriteRefusalOf(await refused.json()).code).toBe('node_text_too_large')
    expect(readSpatialCanvas(await snapshot(`${url}/snapshot`)).nodes).toEqual([])
  })
})

describe('a workspace-document update making a document unreadable', () => {
  it('answers 400 unreadable_document_meta and the document is still listed', async () => {
    const { post, snapshot } = await setup()
    const url = `/api/w/${WS}/workspace-document`
    const seeded = updateFrom(await snapshot(`${url}/snapshot`), (doc) =>
      createWorkspaceDocumentAtPath(doc, { path: 'notes', documentId: DOC_ID, kind: 'markdown' }),
    )
    expect((await post(`${url}/update`, seeded)).status).toBe(200)

    const refused = await post(
      `${url}/update`,
      updateFrom(await snapshot(`${url}/snapshot`), (doc) => {
        const node = doc.getTree('tree').getNodes()[0]
        node?.data.set('kind', 'bogus')
      }),
    )

    expect(refused.status).toBe(400)
    expect(syncWriteRefusalOf(await refused.json()).code).toBe('unreadable_document_meta')
    const stored = await snapshot(`${url}/snapshot`)
    expect(readWorkspaceDocuments(stored).map((entry) => entry.path)).toEqual(['notes'])
  })
})

describe('a workspace-document update giving a document a name past its bound', () => {
  it('answers 400 document_name_too_long and the stored name is unchanged', async () => {
    const { post, snapshot } = await setup()
    const url = `/api/w/${WS}/workspace-document`
    const seeded = updateFrom(await snapshot(`${url}/snapshot`), (doc) =>
      createWorkspaceDocumentAtPath(doc, { path: 'notes', documentId: DOC_ID, kind: 'markdown' }),
    )
    expect((await post(`${url}/update`, seeded)).status).toBe(200)
    const named = readWorkspaceDocuments(await snapshot(`${url}/snapshot`)).map((e) => e.name)

    const refused = await post(
      `${url}/update`,
      updateFrom(await snapshot(`${url}/snapshot`), (doc) => {
        const node = doc.getTree('tree').getNodes()[0]
        node?.data.set('name', 'n'.repeat(DOCUMENT_NAME_MAX_LENGTH + 1))
      }),
    )

    expect(refused.status).toBe(400)
    expect(syncWriteRefusalOf(await refused.json()).code).toBe('document_name_too_long')
    const stored = await snapshot(`${url}/snapshot`)
    expect(readWorkspaceDocuments(stored).map((entry) => entry.name)).toEqual(named)
  })
})

describe('an editor sync write giving a label or a comment message past its bound', () => {
  it.each([
    {
      code: 'label_too_large',
      edit: (doc: LoroDoc) =>
        writeSpatialNode(
          doc,
          groupNode({
            id: 'g',
            x: 0,
            y: 0,
            width: 400,
            height: 200,
            label: 'x'.repeat(LABEL_MAX_CHARS + 1),
          }),
        ),
    },
    {
      code: 'comment_too_large',
      edit: (doc: LoroDoc) =>
        writeCommentThread(doc, {
          id: 't',
          anchor: { kind: 'document' },
          status: 'open',
          messages: [{ id: 'm1', body: 'x'.repeat(COMMENT_MESSAGE_MAX_CHARS + 1) }],
        }),
    },
  ])('answers 413 $code, a code the client contract reads', async ({ code, edit }) => {
    const { post, snapshot } = await setup()
    const url = `/api/w/${WS}/document/board`
    expect(
      (
        await post(
          `${url}/update`,
          updateFrom(new LoroDoc(), () => {}),
        )
      ).status,
    ).toBe(200)

    const refused = await post(`${url}/update`, updateFrom(await snapshot(`${url}/snapshot`), edit))

    expect(refused.status).toBe(413)
    expect(syncWriteRefusalOf(await refused.json()).code).toBe(code)
  })
})
