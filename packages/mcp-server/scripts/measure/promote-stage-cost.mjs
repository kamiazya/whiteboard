/**
 * Where the time of one promote goes, per stage, over a browser record of N
 * markdown documents merged into a fresh daemon workspace through the real
 * store: the record opens, reads and writes the operations make, the
 * persistence of each, the version rows adopted and the per-document
 * checkpoints. `promote-cost.mjs` answers how long the whole takes; this
 * answers which part of it grows with N.
 *
 * Stages are wall milliseconds summed over one promote. Each `versions.save`
 * call is also timed on its own, and the first and last tenth of them are
 * compared: a per-call cost that rises across the run is a cost that grows
 * with what the run has already done. `unattributed` is the total less every
 * stage timed, so a stage this script cannot see shows as a gap rather than
 * as nothing.
 *
 * Run (from packages/mcp-server):
 *   node --import tsx/esm scripts/measure/promote-stage-cost.mjs [documents]
 *
 * With PROFILE=1 the run is repeated under `--cpu-prof` by the caller; this
 * script only prints.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { promoteWorkspace } from '@kamiazya/whiteboard-server-core'
import { LoroDoc } from 'loro-crdt'
import { bootSelfHostDeps } from '../../src/di/boot-self-host-deps.ts'
import { resetDataDirForTests, setDataDirForTests } from '../../src/shared/data-dir-secure.ts'

const COUNT = Number(process.argv[2] ?? 90)
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const idOf = (prefix, i) => `${prefix}${ALPHABET[Math.floor(i / 32) % 32]}${ALPHABET[i % 32]}`
const body = (i) => `# Note ${i}\n\n${'A sentence of ordinary prose. '.repeat(60)}`

const doc = new LoroDoc()
doc.setPeerId(2n)
for (let i = 0; i < COUNT; i++) {
  const documentId = idOf('01BRWDDD0000000000000000', i)
  createWorkspaceDocumentAtPath(doc, { path: `notes/n${i}`, documentId, kind: 'markdown' })
  writeMarkdownBody(documentContainers(doc, documentId), body(i))
}
doc.commit()
const snapshot = new Uint8Array(doc.export({ mode: 'snapshot' }))

const stages = new Map()
const note = (label, ms) => {
  const held = stages.get(label) ?? { ms: 0, calls: 0 }
  stages.set(label, { ms: held.ms + ms, calls: held.calls + 1 })
}
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

const served = await mkdtemp(join(tmpdir(), 'wb-promote-stage-'))
setDataDirForTests(await mkdtemp(join(tmpdir(), 'wb-promote-stage-ambient-')))
try {
  const { serverDeps } = await bootSelfHostDeps(served)
  const workspaceId = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
  await serverDeps.documentIndex.createWorkspace({ workspaceId })

  // A promote names its record brackets by order: the merge, the trash, the checkpoints.
  let bracket = 0
  const wd = serverDeps.workspaceDocuments
  const saves = []
  const instrumented = {
    ...serverDeps,
    workspaceDocuments: {
      ...wd,
      withRecord: (ws, fn) => {
        const label = `withRecord #${++bracket}`
        const t = performance.now()
        return wd
          .withRecord(ws, (session) =>
            fn({
              ...session,
              read: timed(`${label} read`, (q, shape) => session.read(q, shape)),
              write: (batch) => {
                const t2 = performance.now()
                const out = session.write(batch)
                note(`${label} write`, performance.now() - t2)
                return out
              },
              save: timed(`${label} save`, () => session.save()),
            }),
          )
          .finally(() => note(label, performance.now() - t))
      },
    },
    versions: {
      ...serverDeps.versions,
      save: async (...args) => {
        const t = performance.now()
        try {
          return await serverDeps.versions.save(...args)
        } finally {
          const ms = performance.now() - t
          saves.push(ms)
          note('versions.save', ms)
        }
      },
      saveAll: timed('versions.saveAll', (...args) => serverDeps.versions.saveAll(...args)),
      adopt: timed('versions.adopt', (...args) => serverDeps.versions.adopt(...args)),
    },
  }

  const start = performance.now()
  const result = await promoteWorkspace(instrumented, {
    workspaceId,
    snapshot,
    operator: { kind: 'human', displayName: 'measure' },
  })
  const total = performance.now() - start
  if (result.kind !== 'promoted') throw new Error(`not promoted: ${result.kind}`)

  const median = (values) => [...values].sort((a, b) => a - b)[values.length >> 1]

  // One checkpoint's parts, on the promoted workspace: the two reads it makes of
  // the record (the entry at a path, the node count of a document) and the whole
  // call, so what the call spends outside the record's reads shows as the rest.
  const asserted = { parse: (value) => value }
  const SAMPLES = 20
  const partsOf = async () => {
    const entry = []
    const count = []
    const whole = []
    for (let i = 0; i < SAMPLES; i++) {
      const path = `notes/n${Math.floor((i * COUNT) / SAMPLES)}`
      let documentId
      await wd.withRecord(workspaceId, async (record) => {
        const t = performance.now()
        const found = await record.read(
          { query: 'workspaceDocumentEntry', args: { path } },
          asserted,
        )
        entry.push(performance.now() - t)
        documentId = found.documentId
        const t2 = performance.now()
        await record.read({ query: 'spatialNodeCount', args: { documentId } }, asserted)
        count.push(performance.now() - t2)
      })
      const t3 = performance.now()
      await serverDeps.versions.save(workspaceId, path, { auto: true })
      whole.push(performance.now() - t3)
    }
    return {
      entryReadMedianMs: Number(median(entry).toFixed(2)),
      nodeCountReadMedianMs: Number(median(count).toFixed(2)),
      versionsSaveMedianMs: Number(median(whole).toFixed(2)),
    }
  }
  const parts = await partsOf()
  const tenth = Math.max(1, Math.floor(saves.length / 10))
  const rows = [...stages.entries()].map(([label, { ms, calls }]) => ({
    stage: label,
    ms: Number(ms.toFixed(1)),
    calls,
  }))
  // The brackets contain their own reads and writes; the stages that do not nest
  // are the brackets and the version calls, so those are what the gap is taken from.
  const outer = rows
    .filter((row) => /^withRecord #\d+$/.test(row.stage) || row.stage.startsWith('versions.'))
    // checkpoints run inside bracket 3, so its time already holds versions.save
    .filter((row) => row.stage !== 'versions.save' && row.stage !== 'versions.saveAll')
    .reduce((sum, row) => sum + row.ms, 0)
  console.log(
    JSON.stringify({
      documents: COUNT,
      totalMs: Number(total.toFixed(1)),
      unattributedMs: Number((total - outer).toFixed(1)),
      // Per-call medians exist only when the promote saves a document at a time.
      ...(saves.length === 0
        ? {}
        : {
            saveFirstTenthMedianMs: Number(median(saves.slice(0, tenth)).toFixed(2)),
            saveLastTenthMedianMs: Number(median(saves.slice(-tenth)).toFixed(2)),
          }),
      afterwards: parts,
      stages: rows,
    }),
  )
} finally {
  resetDataDirForTests()
}
process.exit(0)
