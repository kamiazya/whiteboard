/**
 * Where the time of one in-place restore goes, per stage, over a workspace of N
 * documents through the real store: the reads and writes the restore makes of
 * the record (open, path read, content write, name seed, save, projection
 * eviction) and the write observer, or on a tree that restores through live
 * documents, their get and save. Medians of 15 restores, wall milliseconds;
 * `total` is the whole operation.
 *
 * Run (from packages/mcp-server):
 *   node --import tsx/esm scripts/measure/restore-stage-cost.mjs [documents]
 */
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
 * the medians: a single run is one process's allocation history. `loadMs` is
 * the past state of one document, which is a copy of the record at a version;
 * `restoreMs` a restore in place that alternates between two saved states.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeMarkdownBody } from '@kamiazya/whiteboard-loro-adapter'
import { restoreVersion, wbDocumentCreate } from '@kamiazya/whiteboard-server-core'
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
  const live = serverDeps.liveDocuments
  const setBody = (text) =>
    live.withWriteLock(WORKSPACE, async () => {
      const doc = await live.get(WORKSPACE, target)
      writeMarkdownBody(doc, text)
      doc.commit()
      await live.save(WORKSPACE, target, doc, { overwrite: true })
    })
  await setBody('# State A')
  const stateA = await store.save(WORKSPACE, target, { auto: false })
  await setBody('# State B')
  const stateB = await store.save(WORKSPACE, target, { auto: false })
  // Stage timers: whichever of these a tree's restore calls.
  const stages = new Map()
  const note = (label, ms) => stages.set(label, (stages.get(label) ?? 0) + ms)
  const timed =
    (label, fn) =>
    async (...args) => {
      const t = performance.now()
      try {
        return await fn(...args)
      } finally {
        note(label, performance.now() - t)
      }
    }
  const realGet = live.get.bind(live)
  const realSave = live.save.bind(live)
  const instrumented = {
    ...serverDeps,
    liveDocuments: { ...live, get: timed('live.get', realGet), save: timed('live.save', realSave) },
  }
  if (serverDeps.workspaceDocuments.open) {
    const wd = serverDeps.workspaceDocuments
    instrumented.workspaceDocuments = {
      ...wd,
      open: async (ws) => {
        const t = performance.now()
        const session = await wd.open(ws)
        note('open', performance.now() - t)
        return {
          ...session,
          read: timed('read', (q, shape) => session.read(q, shape)),
          write: (batch) => {
            const t2 = performance.now()
            const out = session.write(batch)
            note(`write ${batch[0]?.op}`, performance.now() - t2)
            return out
          },
          save: timed('save', () => session.save()),
        }
      },
      evictProjections: (ws) => {
        const t = performance.now()
        wd.evictProjections(ws)
        note('evictProjections', performance.now() - t)
      },
    }
  }
  if (serverDeps.documentWritten)
    instrumented.documentWritten = timed('documentWritten', serverDeps.documentWritten)
  const labelsOf = new Map()
  let toggle = false
  const runs = []
  for (let i = 0; i < 16; i++) {
    stages.clear()
    toggle = !toggle
    const t = performance.now()
    await restoreVersion(instrumented, {
      workspaceId: WORKSPACE,
      path: target,
      versionId: (toggle ? stateA : stateB).id,
    })
    const total = performance.now() - t
    if (i > 0) runs.push({ total, ...Object.fromEntries(stages) })
  }
  const keys = new Set(runs.flatMap((r) => Object.keys(r)))
  const median = (key) => {
    const v = runs.map((r) => r[key] ?? 0).sort((a, b) => a - b)
    return Number(v[v.length >> 1].toFixed(2))
  }
  console.log(
    JSON.stringify({
      documents: COUNT,
      ...Object.fromEntries([...keys].map((k) => [k, median(k)])),
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
