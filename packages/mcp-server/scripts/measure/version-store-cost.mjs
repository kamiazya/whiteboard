/**
 * What the version store costs per call over a workspace of N documents,
 * through the real store: a manual save (a checkpoint), the unchanged check the
 * auto-checkpoint scheduler asks before every save, and a listing. Medians of
 * 15 calls, CPU milliseconds.
 *
 * Run (from packages/mcp-server):
 *   node --import tsx/esm scripts/measure/version-store-cost.mjs [documents]
 *
 * Interleave two checkouts by running this in each, alternately, and compare
 * the medians: a single run is one process's allocation history.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wbDocumentCreate } from '@kamiazya/whiteboard-server-core'
import { bootSelfHostDeps } from '../../src/di/boot-self-host-deps.ts'
import { disposeAutoCompact, uninstallAutoCompact } from '../../src/server/store/auto-compact.ts'
import { clearDbCacheForTests, closeDb } from '../../src/server/store/db/index.ts'
import { clearDocCacheForTests } from '../../src/server/store/doc-cache.ts'
import { storeScope } from '../../src/server/store/store-scope.ts'
import { FileVersionStore } from '../../src/server/store/version-store.ts'
import { _clearWorkspaceDocCacheForTests } from '../../src/server/store/workspace-doc-cache.ts'
import { resetDataDirForTests, setDataDirForTests } from '../../src/shared/data-dir-secure.ts'

const WORKSPACE = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const COUNT = Number(process.argv[2] ?? 90)
const CALLS = 15
const body = (i) => `# Note ${i}\n\n${'A sentence of ordinary prose. '.repeat(60)}`

const served = await mkdtemp(join(tmpdir(), 'wb-version-cost-'))
const ambient = await mkdtemp(join(tmpdir(), 'wb-version-cost-ambient-'))
setDataDirForTests(ambient)
try {
  const { serverDeps } = await bootSelfHostDeps(served)
  await serverDeps.documentIndex.createWorkspace({ workspaceId: WORKSPACE })
  for (let i = 0; i < COUNT; i++) {
    await wbDocumentCreate(serverDeps, {
      workspaceId: WORKSPACE,
      path: `notes/n${i}`,
      kind: 'markdown',
      markdown: body(i),
    })
  }
  const store = new FileVersionStore(storeScope(served))
  const target = `notes/n${COUNT - 1}`
  const time = async (call) => {
    await call()
    const samples = []
    for (let i = 0; i < CALLS; i++) {
      const before = process.cpuUsage()
      await call()
      const spent = process.cpuUsage(before)
      samples.push((spent.user + spent.system) / 1000)
    }
    samples.sort((a, b) => a - b)
    return samples[CALLS >> 1].toFixed(2)
  }
  console.log(
    JSON.stringify({
      documents: COUNT,
      saveMs: await time(() => store.save(WORKSPACE, target, { auto: true })),
      unchangedMs: await time(() => store.isUnchangedSinceLastVersion(WORKSPACE, target)),
      listMs: await time(() => store.list(WORKSPACE, target)),
    }),
  )
} finally {
  uninstallAutoCompact()
  await disposeAutoCompact()
  clearDocCacheForTests()
  _clearWorkspaceDocCacheForTests()
  await closeDb(served)
  clearDbCacheForTests()
  resetDataDirForTests()
  await rm(served, { recursive: true, force: true })
  await rm(ambient, { recursive: true, force: true })
}
