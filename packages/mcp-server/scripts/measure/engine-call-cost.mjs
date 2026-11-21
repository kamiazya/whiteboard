/**
 * What one engine call costs against a workspace record of N documents, held
 * as a lease, set beside the same question asked of a `LoroDoc`: the record's
 * version (`engine.version`), the decoding of a frontiers value
 * (`engine.decode`), the version at a point (the two together), a read of one
 * document's entry by path, and one document's projection exported. Medians of
 * SAMPLES calls (50 by default), wall milliseconds, at 90, 360 and 720
 * documents of real prose.
 *
 * Run (from packages/mcp-server):
 *   node --import tsx/esm scripts/measure/engine-call-cost.mjs
 */
import { createRequire } from 'node:module'
import { corpusSnapshot } from './corpus-record.mjs'

const require = createRequire(import.meta.url)
const SAMPLES = Number(process.env.SAMPLES ?? 50)
const COUNTS = [90, 360, 720]

const median = (values) => [...values].sort((a, b) => a - b)[values.length >> 1]
const timeIt = (fn) => {
  fn()
  const spent = []
  for (let i = 0; i < SAMPLES; i++) {
    const t = performance.now()
    fn()
    spent.push(performance.now() - t)
  }
  return Number(median(spent).toFixed(3))
}

const { LoroDoc } = require('loro-crdt')
const adapter = await import('@kamiazya/whiteboard-loro-adapter')
const kind = adapter.leaseKind(adapter.loadCrdtEngine)
const asserted = { parse: (value) => value }

console.log(
  '  docs   lease: version   decode   versionAt   entry read   projection   |   LoroDoc: oplogVersion   frontiers   entry read   projection',
)
for (const count of COUNTS) {
  const { bytes, documentIds } = await corpusSnapshot(count)
  const lease = await kind.load(bytes, [])
  const session = adapter.bindRecordOps(adapter.leaseOps, lease, async () => {})
  const doc = LoroDoc.fromSnapshot(bytes)

  const point = adapter.leaseOps.versionOf(lease).encodedFrontiers
  const mid = documentIds[count >> 1]
  const entry = await session.read({ query: 'documents' }, asserted)
  const path = entry.find((row) => row.documentId === mid).path

  const engine = lease.engine
  const version = timeIt(() => engine.version({ handle: lease.handle }))
  const decode = timeIt(() =>
    engine.decode({ kind: 'frontiers', bytes: Buffer.from(point).toString('base64') }),
  )
  const versionAt = timeIt(() => adapter.leaseOps.versionAt(lease, point))
  const projection = timeIt(() => adapter.leaseOps.exportProjection(lease, mid))
  let entryRead = 0
  {
    const spent = []
    for (let i = 0; i < SAMPLES + 1; i++) {
      const t = performance.now()
      await session.read({ query: 'workspaceDocumentEntry', args: { path } }, asserted)
      spent.push(performance.now() - t)
    }
    entryRead = Number(median(spent.slice(1)).toFixed(3))
  }
  const legacy = adapter.bindRecordOps(adapter.legacyRecordOps, doc, async () => {})
  const spentLegacy = []
  for (let i = 0; i < SAMPLES + 1; i++) {
    const t = performance.now()
    await legacy.read({ query: 'workspaceDocumentEntry', args: { path } }, asserted)
    spentLegacy.push(performance.now() - t)
  }
  const legacyEntry = Number(median(spentLegacy.slice(1)).toFixed(3))
  const legacyProjection = timeIt(() => legacy.exportProjection(mid))
  const oplog = timeIt(() => doc.oplogVersion())
  const frontiers = timeIt(() => doc.frontiers())
  console.log(
    `  ${String(count).padStart(4)}   ${String(version).padStart(13)}  ${String(decode).padStart(7)}  ${String(versionAt).padStart(10)}  ${String(entryRead).padStart(11)}  ${String(projection).padStart(11)}   |   ${String(oplog).padStart(17)}  ${String(frontiers).padStart(10)}  ${String(legacyEntry).padStart(11)}  ${String(legacyProjection).padStart(10)}`,
  )
  lease.release()
}
process.exit(0)
