import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeSpatialDoc } from '../../shared/test-utils/spatial-doc.js'
import { ALL_AUTH_SCOPES } from '../security/auth-strategy.js'
import { createCredentialResolver, type ResolvedGrant } from '../security/credential-resolver.js'
import { testStoreScope } from './_test-helpers.js'

let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { clearDocCacheForTests } = await import('../store/doc-cache.js')

const { getDoc, saveDocument } = await import('../store/document-store.js')
const { createDebugRouter } = await import('./debug.js')

function makeDocWithNodes(count: number): LoroDoc {
  return makeSpatialDoc({
    nodes: Array.from({ length: count }, (_, i) =>
      textNode({ id: `n${i}`, text: 'a', x: 0, y: 0, width: 10, height: 10 }),
    ),
    edges: [],
  })
}

// The retired Excalidraw list: a document holding only it has no nodes.
function makeDocWithRetiredElements(count: number): LoroDoc {
  const doc = new LoroDoc()
  const list = doc.getMovableList('elements')
  for (let i = 0; i < count; i++) {
    const map = list.insertContainer(list.length, new LoroMap())
    map.set('id', `el-${i}`)
    map.set('type', 'rectangle')
  }
  doc.commit()
  return doc
}

async function nodeCountsAt(workspaceId: string): Promise<Record<string, number>> {
  const app = createDebugRouter({
    scope: testStoreScope(),
    credentialResolver: createCredentialResolver({}),
  })
  const res = await app.request('/api/debug')
  expect(res.status).toBe(200)
  const json = (await res.json()) as {
    workspaces: Array<{
      workspaceId: string
      documents: Array<{ path: string; nodeCount: number }>
    }>
  }
  const documents = json.workspaces.find((w) => w.workspaceId === workspaceId)?.documents
  expect(documents).toBeDefined()
  return Object.fromEntries(documents!.map((d) => [d.path, d.nodeCount]))
}

describe('GET /api/debug', () => {
  const originalDebugEnv = process.env.WHITEBOARD_DEBUG

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-debug-test-'))
    clearDocCacheForTests()
    process.env.WHITEBOARD_DEBUG = '1'
  })

  afterEach(async () => {
    if (originalDebugEnv === undefined) {
      delete process.env.WHITEBOARD_DEBUG
    } else {
      process.env.WHITEBOARD_DEBUG = originalDebugEnv
    }
    await rm(tempDir, { recursive: true, force: true })
    clearDocCacheForTests()
  })

  it("reports each document's node count", async () => {
    await mkdir(join(tempDir, 'sess-a'), { recursive: true })
    await saveDocument('sess-a', 'canvas-1', makeDocWithNodes(3))
    await saveDocument('sess-a', 'canvas-2', makeDocWithNodes(1))

    expect(await nodeCountsAt('sess-a')).toEqual({ 'canvas-1': 3, 'canvas-2': 1 })
  })

  it('counts nodes only, not the edges between them', async () => {
    await mkdir(join(tempDir, 'sess-nodes'), { recursive: true })
    const doc = makeSpatialDoc({
      nodes: [
        textNode({ id: 'n1', text: 'a', x: 0, y: 0, width: 10, height: 10 }),
        textNode({ id: 'n2', text: 'b', x: 0, y: 0, width: 10, height: 10 }),
      ],
      edges: [
        {
          id: 'e1',
          from: { node: 'n1' },
          to: { node: 'n2' },
        },
      ],
    })
    await saveDocument('sess-nodes', 'canvas-1', doc)

    expect(await nodeCountsAt('sess-nodes')).toEqual({ 'canvas-1': 2 })
  })

  it('counts no nodes for a document holding only the retired elements list', async () => {
    await mkdir(join(tempDir, 'sess-retired'), { recursive: true })
    await saveDocument('sess-retired', 'canvas-1', makeDocWithRetiredElements(2))

    expect(await nodeCountsAt('sess-retired')).toEqual({ 'canvas-1': 0 })
  })

  it('marks only documents touched through getDoc as cached in the cache section', async () => {
    await mkdir(join(tempDir, 'sess-cache'), { recursive: true })
    await saveDocument('sess-cache', 'touched', makeDocWithNodes(1))
    await saveDocument('sess-cache', 'untouched', makeDocWithNodes(1))

    // Only touched documents should appear in cache.
    await getDoc('sess-cache', 'touched')

    const app = createDebugRouter({
      scope: testStoreScope(),
      credentialResolver: createCredentialResolver({}),
    })
    const res = await app.request('/api/debug')
    const json = (await res.json()) as {
      workspaces: Array<{
        workspaceId: string
        documents: Array<{ path: string; cached: boolean }>
      }>
      cache: { size: number; keys: string[] }
    }

    expect(json.cache.keys).toContain('sess-cache/touched')
    expect(json.cache.keys).not.toContain('sess-cache/untouched')

    const session = json.workspaces.find((s) => s.workspaceId === 'sess-cache')!
    expect(session.documents.find((c) => c.path === 'touched')?.cached).toBe(true)
    expect(session.documents.find((c) => c.path === 'untouched')?.cached).toBe(false)
  })

  it('returns workspaces: [] when no sessions exist', async () => {
    const app = createDebugRouter({
      scope: testStoreScope(),
      credentialResolver: createCredentialResolver({}),
    })
    const res = await app.request('/api/debug')
    const json = (await res.json()) as { workspaces: unknown[] }
    expect(json.workspaces).toEqual([])
  })

  it('requires bearer auth when a daemon token is configured', async () => {
    process.env.WHITEBOARD_DEBUG = '1'
    const app = createDebugRouter({
      scope: testStoreScope(),
      credentialResolver: createCredentialResolver({ daemonToken: 'secret' }),
    })

    const unauthenticated = await app.request('/api/debug')
    expect(unauthenticated.status).toBe(401)
    await expect(unauthenticated.json()).resolves.toEqual({ error: 'unauthorized' })

    const authenticated = await app.request('/api/debug', {
      headers: { Authorization: 'Bearer secret' },
    })
    expect(authenticated.status).toBe(200)
  })

  it.for([
    'signed-in',
    'macaroon',
    'external-bearer',
  ] as const)('refuses a %s grant even when it carries every scope', async (kind) => {
    const grant: ResolvedGrant = { kind, scopes: ALL_AUTH_SCOPES }
    const app = createDebugRouter({
      scope: testStoreScope(),
      credentialResolver: { resolve: async () => grant },
    })

    const res = await app.request('/api/debug', { headers: { Authorization: 'Bearer anything' } })

    expect(res.status).toBe(401)
  })

  it('remains public when no daemon token is configured', async () => {
    process.env.WHITEBOARD_DEBUG = '1'
    const app = createDebugRouter({
      scope: testStoreScope(),
      credentialResolver: createCredentialResolver({}),
    })
    const res = await app.request('/api/debug')
    expect(res.status).toBe(200)
  })

  it('returns 404 unless WHITEBOARD_DEBUG=1 is enabled', async () => {
    delete process.env.WHITEBOARD_DEBUG
    const app = createDebugRouter({
      scope: testStoreScope(),
      credentialResolver: createCredentialResolver({ daemonToken: 'secret' }),
    })

    const res = await app.request('/api/debug', {
      headers: { Authorization: 'Bearer secret' },
    })

    expect(res.status).toBe(404)
    // JSON, not Hono's plain-text 404: a caller parsing the body to find out
    // why gets a SyntaxError otherwise, which is the shape the files router
    // once shipped. `route-refusal-shapes.grit` is the rung that stops
    // a new one being written; this is the one that stops this one regressing.
    await expect(res.json()).resolves.toEqual({
      error: 'not_found',
      message: 'Debug endpoint is not enabled',
    })
  })
})
