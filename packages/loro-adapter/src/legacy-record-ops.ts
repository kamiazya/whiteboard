import { bytesToBase64, type documentEngine as wire } from '@kamiazya/whiteboard-model'
import { decodeFrontiers, encodeFrontiers, LoroDoc } from 'loro-crdt'
import { versionOfPairs, versionPairs } from './engine/answers.js'
import { breachOf, touchedSince } from './engine/engine.js'
import { unwrapAnswer } from './engine/read-value.js'
import { readQuery } from './engine/readers.js'
import { applyWriter } from './engine/writers.js'
import type { LegacyRecord } from './legacy-record-kind.js'
import type { RecordOps } from './record-ops.js'
import { documentsRemovedSince } from './removed-documents.js'
import { importWithinTextLimits } from './sync-text-limits.js'
import { judgeWorkspaceSyncImport } from './workspace-sync-limits.js'
import { projectWorkspaceDocument } from './workspace-tree.js'

/**
 * The same named reads, writes and judges the engine answers, run on a
 * `LoroDoc` by the functions the engine itself calls — so the two kinds answer
 * alike by construction, and `record-ops.conformance.test.ts` holds it.
 *
 * ponytail: goes with `loroDocKind`, when the last holder of a `LoroDoc` does.
 */
export const legacyRecordOps: RecordOps<LegacyRecord> = {
  async read(doc, query, shape) {
    const response = { value: await readQuery(doc, query) } as wire.ReadResponse
    return unwrapAnswer(response, query, shape)
  },
  write(doc, batch) {
    const before = doc.oplogVersion()
    for (const { op, args } of batch) applyWriter(doc, op, args)
    doc.commit()
    if (doc.oplogVersion().compare(before) === 0) return { outcome: 'applied', changed: [] }
    const update = doc.export({ mode: 'update', from: before })
    return {
      outcome: 'applied',
      changed: touchedSince(doc, before),
      localUpdate: bytesToBase64(update),
    }
  },
  importJudged(doc, bytes, judge) {
    const before = doc.oplogVersion()
    if (judge === 'none') {
      const pending = (doc.import(bytes).pending?.size ?? 0) > 0
      return { outcome: 'applied', changed: touchedSince(doc, before), pending }
    }
    if (judge === 'text') {
      const { breach, pending } = importWithinTextLimits(doc, bytes)
      if (breach !== null) return { outcome: 'refused', breach: breachOf(breach) }
      return { outcome: 'applied', changed: touchedSince(doc, before), pending }
    }
    const breach = judgeWorkspaceSyncImport(doc, bytes)
    if (breach !== null) return { outcome: 'refused', breach: breachOf(breach) }
    return { outcome: 'applied', changed: touchedSince(doc, before), pending: false }
  },
  versionOf(doc) {
    return {
      encoded: new Uint8Array(doc.oplogVersion().encode()),
      encodedFrontiers: new Uint8Array(encodeFrontiers(doc.oplogFrontiers())),
      entries: versionPairs(doc.oplogVersion()).map(([peer, counter]) => ({ peer, counter })),
    }
  },
  removedSince: (doc, since) =>
    documentsRemovedSince(doc, versionOfPairs(since.map(({ peer, counter }) => [peer, counter]))),
  viewAt(doc, frontiers) {
    const view = doc.fork()
    view.checkout(decodeFrontiers(frontiers))
    return view
  },
  moveView(view, frontiers) {
    view.checkout(decodeFrontiers(frontiers))
  },
  release() {
    // A LoroDoc is garbage collected; nothing to give back.
  },
  exportProjection(doc, documentId) {
    const projected = projectWorkspaceDocument(doc, documentId)
    if (projected === null) return null
    try {
      return new Uint8Array(projected.export({ mode: 'snapshot' }))
    } finally {
      projected.free()
    }
  },
}

/**
 * A document of its own from the bytes a projection export answers, for the
 * consumers that still read a past document through a `LoroDoc`.
 *
 * ponytail: the one place a past state becomes a `LoroDoc`; it goes when
 * restore and the history reads take a document's content through the engine.
 */
export function documentFromSnapshot(bytes: Uint8Array): LoroDoc {
  const doc = new LoroDoc()
  doc.import(bytes)
  return doc
}
