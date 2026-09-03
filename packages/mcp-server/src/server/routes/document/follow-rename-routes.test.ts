/**
 * The path-move route carries the follow pass: after a move, references
 * other documents wrote to the OLD path are repointed (server-core's
 * `followReferencesAfterRename`). Proven through the ROUTE, against real
 * default deps in a temp data dir — the same surface the web app's Rename
 * dialog reaches. Display-name changes deliberately rewrite nothing: name
 * references are being retired from resolution.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  readMarkdownBody,
  writeDocumentKind,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { beforeEach, describe, expect, it } from 'vitest'
import * as documentStore from '../../store/document-store.js'
import { withTempDataDir } from '../_test-helpers.js'
import { createDocumentRouter } from '../document.js'

// `withTempDataDir` only registers beforeEach/afterEach hooks — it sets
// nothing at module scope — so these imports never had to be deferred past
// it.
const tmp = withTempDataDir('whiteboard-follow-rename-test-')
const { getDoc } = documentStore

async function seedMarkdown(workspaceId: string, path: string, body: string) {
  const doc = new LoroDoc()
  writeDocumentKind(doc, 'markdown')
  writeMarkdownBody(doc, body)
  await documentStore.saveDocument(workspaceId, path, doc)
}

async function bodyAt(workspaceId: string, path: string): Promise<string> {
  const doc = await getDoc(workspaceId, path)
  return readMarkdownBody(doc)
}

describe('rename routes follow references', () => {
  beforeEach(async () => {
    await mkdir(join(tmp.dir, 'session1'), { recursive: true })
  })

  it('PUT :path/path repoints references written as the old path', async () => {
    await seedMarkdown('session1', 'design/login', 'the target')
    await seedMarkdown('session1', 'notes/daily', 'see [[design/login]] and [[unrelated]]')
    const app = createDocumentRouter()

    const res = await app.request('/api/workspaces/session1/documents/design%2Flogin/path', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'archive/login' }),
    })
    expect(res.status).toBe(200)

    expect(await bodyAt('session1', 'notes/daily')).toBe('see [[archive/login]] and [[unrelated]]')
  })

  it('PUT :path/path follows references to a moved DESCENDANT too', async () => {
    await mkdir(join(tmp.dir, 'session3'), { recursive: true })
    await seedMarkdown('session3', 'folder', 'the parent')
    await seedMarkdown('session3', 'folder/child', 'the child')
    await seedMarkdown('session3', 'notes/daily', 'see [[folder/child]]')
    const app = createDocumentRouter()

    const res = await app.request('/api/workspaces/session3/documents/folder/path', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'archive/folder' }),
    })
    expect(res.status).toBe(200)

    expect(await bodyAt('session3', 'notes/daily')).toBe('see [[archive/folder/child]]')
  })
})
