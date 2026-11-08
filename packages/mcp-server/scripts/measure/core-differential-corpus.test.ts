import { existsSync } from 'node:fs'
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { chunkSnapshot } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bootSelfHostDeps } from '../../src/di/boot-self-host-deps.js'
import { stagedArtifacts } from '../../src/server/export/layout-core.js'
import { disposeAutoCompact, uninstallAutoCompact } from '../../src/server/store/auto-compact.js'
import { clearDbCacheForTests, closeDb } from '../../src/server/store/db/index.js'
import { clearDocCacheForTests } from '../../src/server/store/doc-cache.js'
import { _clearWorkspaceDocCacheForTests } from '../../src/server/store/workspace-doc-cache.js'
import { collectingCore, measureCorpus } from './core-differential-corpus.mjs'

// The rust job and test-unit stage the artifact before this file runs, so on
// CI its absence is a failure rather than a skip.
const staged = stagedArtifacts()
const built = existsSync(join(staged, 'whiteboard_wasm_bg.wasm'))

const WORKSPACE = '01ZVM89A4A1V9FS03Z9J64KEK1'

const canvas: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 0, y: 0, width: 120, height: 60, text: 'a' }),
    textNode({ id: 'b', x: 400, y: 0, width: 120, height: 60, text: 'b' }),
    textNode({ id: 'c', x: 200, y: 300, width: 120, height: 60, text: 'c' }),
  ],
  edges: [
    { id: 'e1', from: { node: 'a' }, to: { node: 'b' } },
    { id: 'e2', from: { node: 'b' }, to: { node: 'c' } },
  ],
  facets: { 'visual.edges/v0': { routing: 'orthogonal' } },
} as SpatialCanvas

const dirs: string[] = []
afterEach(async () => {
  uninstallAutoCompact()
  await disposeAutoCompact()
  clearDocCacheForTests()
  _clearWorkspaceDocCacheForTests()
  for (const dir of dirs.splice(0)) {
    await closeDb(dir)
    await rm(dir, { recursive: true, force: true })
  }
  clearDbCacheForTests()
})

/** A data dir holding one spatial document with edges, written through the real store. */
async function seededDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wb-corpus-seed-'))
  dirs.push(dir)
  const { serverDeps: deps } = await bootSelfHostDeps(dir)
  await deps.documentIndex.createWorkspace({ workspaceId: WORKSPACE })
  const { documentId } = await deps.documentIndex.createDocument({
    workspaceId: WORKSPACE,
    path: 'board',
    kind: 'spatial',
  })
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, canvas)
  const snapshot = chunkSnapshot(doc.export({ mode: 'snapshot' }), 1 << 20)
  await deps.documentStore.saveSnapshot({
    docRef: { kind: 'document', workspaceId: WORKSPACE, documentId },
    manifest: snapshot.manifest,
    chunks: snapshot.chunks,
    frontier: new Uint8Array(),
  })
  await closeDb(dir)
  clearDbCacheForTests()
  return dir
}

/** Every file of a dir, by name, with its bytes. */
async function snapshotDir(dir: string): Promise<Record<string, Buffer>> {
  const names = (await readdir(dir)).sort()
  const out: Record<string, Buffer> = {}
  for (const name of names) out[name] = await readFile(join(dir, name))
  return out
}

const differs = {
  fn: 'routeLayout' as const,
  kind: 'differs' as const,
  at: 3,
  ts: [0, 1, 2, 10],
  rust: [0, 1, 2, 11],
  repro: { edges: [{}, {}] },
}

describe('the differential corpus script', () => {
  it('keeps each reported mismatch, summarized, and counts routed layouts', () => {
    const calls: unknown[] = []
    const base = {
      impl: { routeLayout: 'differential' },
      routing: { routeLayout: (...args: unknown[]) => calls.push(args) },
    }
    const collecting = collectingCore(base)
    collecting.core.routing.routeLayout()
    collecting.core.onMismatch(differs)
    expect(collecting.current().routed).toBe(1)
    expect(collecting.current().mismatches).toEqual([
      { fn: 'routeLayout', kind: 'differs', at: 3, ts: 10, rust: 11, edges: 2 },
    ])
    collecting.reset()
    expect(collecting.current()).toEqual({ mismatches: [], routed: 0 })
  })

  it('reports an unloadable core instead of comparing nothing', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'wb-corpus-empty-core-'))
    try {
      const result = await measureCorpus({ dataDir: await seededDataDir(), coreDir: empty })
      expect(result.coreLoaded).toBe(false)
      expect(result.documents).toEqual([])
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })

  it('refuses a run whose database lives outside the copied dir', async () => {
    const dataDir = await seededDataDir()
    vi.stubEnv('WHITEBOARD_DATABASE_URL', `file:${join(dataDir, 'whiteboard.db')}`)
    try {
      await expect(measureCorpus({ dataDir })).rejects.toThrow(/WHITEBOARD_DATABASE_URL/)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('has the staged artifact wherever CI runs this file', () => {
    if (process.env.CI) expect(built).toBe(true)
  })

  describe.runIf(built)('over the staged artifact', () => {
    it('routes a seeded document and leaves the data dir it read untouched', async () => {
      // The seed's store keeps a connection past closeDb whose own close later
      // checkpoints the WAL into the db, so the seed dir is no fixed point to
      // compare against. A copy nothing has opened is.
      const dataDir = await mkdtemp(join(tmpdir(), 'wb-corpus-read-'))
      dirs.push(dataDir)
      await cp(await seededDataDir(), dataDir, { recursive: true })
      const before = await snapshotDir(dataDir)

      const result = await measureCorpus({ dataDir })

      expect(result.coreLoaded).toBe(true)
      expect(result.documents).toHaveLength(1)
      const [row] = result.documents
      expect(row.failure).toBeUndefined()
      expect(row.nodes).toBe(3)
      expect(row.edges).toBe(2)
      expect(row.routed).toBeGreaterThan(0)
      expect(row.mismatches).toEqual([])
      expect(await snapshotDir(dataDir)).toEqual(before)
    })
  })
})
