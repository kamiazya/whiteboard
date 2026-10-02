/**
 * `createApp` over a data dir the process global does not name serves THAT dir.
 *
 * `bootSelfHostDeps(served)` builds the deps over `served`, and `createApp`
 * mounts routers beside them. A router that reached a store by its default
 * parameter, or built its own `FileVersionStore()`, followed the process's
 * `getDataDir()` instead — so on a keeper whose served dir is not the
 * process's the deps and the routes disagreed, and nothing said so: a version
 * list answered `[]`, a manual save wrote its row into the wrong database, a
 * backup would have copied the wrong tree.
 *
 * Every case here seeds BOTH dirs with the same workspace and document id and
 * puts the evidence only in `served`, so a route that follows the global
 * answers with the ambient dir's emptiness rather than refusing the address.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setWorkspaceLastCompactedAt, writeSpatialNode } from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { type ServerDeps, wbDocumentCreate } from '@kamiazya/whiteboard-server-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bootSelfHostDeps } from '../di/boot-self-host-deps.js'
import { resetDataDirForTests, setDataDirForTests } from '../shared/data-dir-secure.js'
import { PACKAGE_VERSION } from '../shared/package-version.js'
import { createApp } from './app.js'
import { disposeAutoCompact, uninstallAutoCompact } from './store/auto-compact.js'
import { clearDbCacheForTests, closeDb } from './store/db/index.js'
import { clearDocCacheForTests } from './store/doc-cache.js'
import { loadWorkspaceNames } from './store/names-store.js'
import { storeScope } from './store/store-scope.js'
import { _clearWorkspaceDocCacheForTests } from './store/workspace-doc-cache.js'

const WS = 'ws-1'
const MARK = 'only-in-served'
const SERVED_ONLY_WORKSPACE = 'ws-only-in-served'

let served: string
let ambient: string

beforeEach(async () => {
  served = await mkdtemp(join(tmpdir(), 'wb-served-'))
  ambient = await mkdtemp(join(tmpdir(), 'wb-ambient-'))
  setDataDirForTests(ambient)
  vi.stubEnv('WHITEBOARD_DEBUG', '1')
  vi.stubEnv('WHITEBOARD_FILE_GC_GRACE_MS', '0')
})

afterEach(async () => {
  uninstallAutoCompact()
  await disposeAutoCompact()
  clearDocCacheForTests()
  _clearWorkspaceDocCacheForTests()
  await closeDb(served)
  await closeDb(ambient)
  clearDbCacheForTests()
  resetDataDirForTests()
  vi.unstubAllEnvs()
  await rm(served, { recursive: true, force: true })
  await rm(ambient, { recursive: true, force: true })
})

async function seed(deps: ServerDeps, paths: readonly string[]): Promise<void> {
  await deps.documentIndex.createWorkspace({ workspaceId: WS })
  for (const path of paths) {
    await wbDocumentCreate(deps, { workspaceId: WS, path, kind: 'spatial' })
  }
}

/** Two keepers over two dirs; the process global names `ambient`, the app serves `served`. */
async function bootBoth() {
  const other = await bootSelfHostDeps(ambient)
  await seed(other.serverDeps, ['note'])
  const boot = await bootSelfHostDeps(served)
  await seed(boot.serverDeps, ['note', MARK])
  await boot.serverDeps.documentIndex.createWorkspace({ workspaceId: SERVED_ONLY_WORKSPACE })
  // The served `note` carries a node, so a read that landed on the ambient
  // one is told apart from one that did not by what it drew or counted.
  const doc = await boot.serverDeps.liveDocuments.get(WS, 'note')
  writeSpatialNode(doc, textNode({ id: 'n1', x: 0, y: 0, width: 120, height: 40, text: MARK }))
  await boot.serverDeps.liveDocuments.save(WS, 'note', doc, { overwrite: true })
  const version = await boot.serverDeps.versions.save(WS, 'note', doc, { auto: false })
  const app = createApp({
    authMode: 'local-daemon',
    serverDeps: boot.serverDeps,
    dataLayout: boot.dataLayout,
    touch: () => {},
    getStatus: () => ({
      ok: true,
      pid: 1,
      socketPath: '/run/wb.sock',
      version: PACKAGE_VERSION,
      startedAt: '2026-04-23T00:00:00.000Z',
      uptimeMs: 1,
      idleForMs: 0,
      auth: { mode: 'local-token', hasToken: false },
      storage: { dataDir: served, dataDirWritable: true },
      mcp: { httpEnabled: true },
      clients: { connected: 0, ready: 0 },
    }),
  })
  return { app, boot, other, version, scope: storeScope(served) }
}

function json(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

describe('createApp over a dir the process global does not name', () => {
  it('lists the versions the served dir holds', async () => {
    const { app, version } = await bootBoth()
    const res = await app.request(`/api/workspaces/${WS}/documents/note/versions`)
    const body = (await res.json()) as { versions: { id: string }[] }
    expect(body.versions.map((v) => v.id)).toEqual([version.id])
  })

  it('writes a manual save of the served document into the served database only', async () => {
    const { app, boot, other } = await bootBoth()
    const res = await app.request(
      `/api/workspaces/${WS}/documents/note/versions`,
      json({ label: 'manual' }),
    )
    expect(res.status).toBe(200)
    const saved = (await res.json()) as { version: { id: string; elementCount: number } }
    // Counted off the served document: the ambient one is empty.
    expect(saved.version.elementCount).toBe(1)
    expect((await boot.serverDeps.versions.list(WS, 'note')).map((v) => v.id)).toContain(
      saved.version.id,
    )
    expect(await other.serverDeps.versions.list(WS, 'note')).toEqual([])
  })

  it("prunes the served workspace, whose documents are not the ambient one's", async () => {
    const { app } = await bootBoth()
    const res = await app.request(`/api/workspaces/${WS}/versions/prune-sandwiched`, json({}))
    const body = (await res.json()) as { results: { path: string }[] }
    // `MARK` is a document of the served dir alone.
    expect(body.results.map((r) => r.path)).toContain(MARK)
  })

  it('optimises the served workspace record, which holds a version', async () => {
    const { app } = await bootBoth()
    const res = await app.request(`/api/workspaces/${WS}/documents/optimize-all`, json({}))
    const result = (await res.json()) as { reason: string }
    // The ambient dir holds no version, which is what `no-versions` answers.
    expect(result.reason).not.toBe('no-versions')
  })

  it('renames a workspace in the served dir, and the names read back from it', async () => {
    const { app, scope } = await bootBoth()
    const put = await app.request(`/api/workspaces/${WS}/name`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Served' }),
    })
    expect(put.status).toBe(200)
    expect((await loadWorkspaceNames(WS, scope)).workspace).toBe('Served')
    expect(
      (await (await app.request(`/api/workspaces/${WS}/names`)).json()) as never,
    ).toMatchObject({
      workspace: 'Served',
    })
    expect((await loadWorkspaceNames(WS, storeScope(ambient))).workspace).toBeUndefined()
  })

  it('purges a dangling file from the served workspace', async () => {
    const { app, scope } = await bootBoth()
    const files = scope.layout.workspaceFilesDir(WS)
    await mkdir(files, { recursive: true })
    await writeFile(join(files, 'dangling.png'), 'x')

    const res = await app.request(`/api/workspaces/${WS}/files/purge-dangling`, json({}))
    expect(((await res.json()) as { purgedCount: number }).purgedCount).toBe(1)
    expect(await readdir(files)).toEqual([])
  })

  it('reports the served workspaces, documents and cache on the debug dump', async () => {
    const { app, boot } = await bootBoth()
    // Resident in the served cache, and nowhere in the ambient one.
    await boot.serverDeps.liveDocuments.get(WS, MARK)
    const res = await app.request('/api/debug')
    const body = (await res.json()) as {
      workspaces: { workspaceId: string; documents: { path: string; cached: boolean }[] }[]
      cache: { keys: string[] }
    }
    // Both halves of the listing: which workspaces exist, then which documents.
    expect(body.workspaces.map((w) => w.workspaceId)).toContain(SERVED_ONLY_WORKSPACE)
    const ws = body.workspaces.find((w) => w.workspaceId === WS)
    expect(ws?.documents.map((d) => d.path)).toContain(MARK)
    expect(ws?.documents.find((d) => d.path === MARK)?.cached).toBe(true)
    expect(body.cache.keys).toContain(`${WS}/${MARK}`)
  })

  it('reads the last compaction stamp off the served dir', async () => {
    const { app, boot } = await bootBoth()
    const workspaceDoc = await boot.serverDeps.workspaceDocuments.get(WS)
    setWorkspaceLastCompactedAt(workspaceDoc, 1_234_567)
    await boot.serverDeps.workspaceDocuments.save(WS, workspaceDoc)

    const res = await app.request('/api/runtime/storage')
    expect(((await res.json()) as { lastAutoCompactedAt: number | null }).lastAutoCompactedAt).toBe(
      1_234_567,
    )
  })

  it('walks the served dir for the storage report', async () => {
    const { app } = await bootBoth()
    type Report = { byCategory: { other: { bytes: number; files: number } } }
    const other = async () =>
      ((await (await app.request('/api/runtime/storage')).json()) as Report).byCategory.other
    const before = await other()

    // A top-level file is classed `other`; written to the served dir alone, so
    // a walk of the ambient one cannot see it.
    await writeFile(join(served, 'stray.bin'), 'seven b')

    const after = await other()
    expect({ bytes: after.bytes - before.bytes, files: after.files - before.files }).toEqual({
      bytes: 7,
      files: 1,
    })
  })

  it('exports the served document, not the ambient one of the same address', async () => {
    const { app } = await bootBoth()
    const res = await app.request(`/api/w/${WS}/document/note/export-svg`, json({}))
    expect(res.status).toBe(200)
    const { filePath } = (await res.json()) as { filePath: string }
    expect(await readFile(filePath, 'utf-8')).toContain(MARK)
  })
})
