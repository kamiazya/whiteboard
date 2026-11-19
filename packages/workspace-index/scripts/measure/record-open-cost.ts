/**
 * What holding a workspace record as an engine lease costs to OPEN, beside
 * holding it as a `LoroDoc`: the snapshot and the log after it, for a
 * workspace of 90 and of 360 documents.
 *
 *   pnpm --filter @kamiazya/whiteboard-mcp exec tsx \
 *     ../workspace-index/scripts/measure/record-open-cost.ts
 *
 * `leaseKind` pays base64 on every byte it hands the engine and a second
 * document inside it; `loroDocKind` imports into a `LoroDoc` directly. The two
 * run interleaved, so a drifting machine moves both, and each figure is the
 * median of 21 runs after a warm-up, in milliseconds. A lease is released
 * inside the timed region, since a keeper that opens one owes the release.
 */
import {
  createWorkspaceDocument,
  leaseKind,
  loadCrdtEngine,
  loroDocKind,
  type RecordKind,
} from '@kamiazya/whiteboard-loro-adapter'
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'

const RUNS = 21
const LOG_UPDATES = 20

function recordOf(documents: number): { snapshot: Uint8Array; updates: Uint8Array[] } {
  const doc = new LoroDoc()
  const add = (index: number) =>
    createWorkspaceDocument(doc, {
      documentId: generateDocumentId(),
      segment: `doc-${index}`,
      kind: index % 2 === 0 ? 'markdown' : 'spatial',
      name: `Document number ${index}`,
    })
  for (let i = 0; i < documents; i++) add(i)
  doc.commit()
  const snapshot = new Uint8Array(doc.export({ mode: 'snapshot' }))
  const updates: Uint8Array[] = []
  for (let i = 0; i < LOG_UPDATES; i++) {
    const from = doc.oplogVersion()
    add(documents + i)
    doc.commit()
    updates.push(new Uint8Array(doc.export({ mode: 'update', from })))
  }
  return { snapshot, updates }
}

async function openOnce(kind: RecordKind<unknown>, held: ReturnType<typeof recordOf>) {
  const start = performance.now()
  const record = await kind.load(held.snapshot, held.updates)
  kind.release(record)
  return performance.now() - start
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1] ?? 0

const kinds = {
  loroDocKind: loroDocKind as RecordKind<unknown>,
  leaseKind: leaseKind(loadCrdtEngine) as RecordKind<unknown>,
}

for (const documents of [90, 360]) {
  const held = recordOf(documents)
  for (const kind of Object.values(kinds)) await openOnce(kind, held)
  const times: Record<string, number[]> = { loroDocKind: [], leaseKind: [] }
  for (let run = 0; run < RUNS; run++) {
    for (const [name, kind] of Object.entries(kinds)) times[name]?.push(await openOnce(kind, held))
  }
  const [doc, lease] = [median(times.loroDocKind ?? []), median(times.leaseKind ?? [])]
  console.log(
    `${documents} documents, snapshot ${held.snapshot.byteLength} B + ${LOG_UPDATES} updates: ` +
      `loroDocKind ${doc.toFixed(2)} ms, leaseKind ${lease.toFixed(2)} ms (x${(lease / doc).toFixed(2)})`,
  )
}
