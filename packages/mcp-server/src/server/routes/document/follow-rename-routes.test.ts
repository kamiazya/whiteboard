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
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { LoroDoc } from 'loro-crdt'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveTestServerDeps, withTempDataDir } from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-follow-rename-test-')

// The store and the router's deps must share ONE data dir, and it must be
// this test's: without the mock the store wrote wherever the process's
// config pointed while the deps were built over `tmp.dir`, and under
// `--repeats` the fixed paths seeded below met their own previous run.
vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const documentStore = await import('../../store/document-store.js')
const { clearCache } = await import('../../store/doc-cache.js')
const { createDocumentRouter } = await import('../document.js')

// The deps a router is handed by its root; here, the test wiring over the
// temp data dir (routers no longer compose their own).
let serverDeps: ServerDeps
beforeEach(async () => {
  clearCache()
  serverDeps = await resolveTestServerDeps(tmp.dir)
})
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
    const app = createDocumentRouter({ serverDeps })

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
    const app = createDocumentRouter({ serverDeps })

    const res = await app.request('/api/workspaces/session3/documents/folder/path', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'archive/folder' }),
    })
    expect(res.status).toBe(200)

    expect(await bodyAt('session3', 'notes/daily')).toBe('see [[archive/folder/child]]')
  })
})
