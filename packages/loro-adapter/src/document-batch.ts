import type { ProposedChangeStatus, SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { DocumentContainers } from './containers.js'
import { writeMarkdownBodyInto, writeSpatialCanvasInto } from './loro-bridge.js'
import { setProposedChangeStatusInto } from './proposals.js'

/**
 * The writes one act of a person may span, across a document's subjects
 * rather than only its canvas.
 */
export interface DocumentBatchWriter {
  setProposedChangeStatus(proposalId: string, changeId: string, status: ProposedChangeStatus): void
  writeSpatialCanvas(canvas: SpatialCanvas): void
  writeMarkdownBody(body: string): void
}

/**
 * `withSpatialBatch`'s sibling for an act that touches more than the canvas:
 * every write in `fn` lands in ONE Loro commit — one local-update payload,
 * one undo step.
 *
 * Deciding a proposal is why it exists. That act stamps a status per change,
 * resyncs the canvas, and rewrites the body; each committing helper on its
 * own made that four independent deltas (measured: three synchronous commits
 * produce three separate `subscribeLocalUpdates` payloads, one produces one).
 * A transport that died between them left the change marked adopted with the
 * words it promised to rewrite still on the page — and undoing the decision
 * took as many presses as it had written commits.
 *
 * Error contract, matching `withSpatialBatch`: if `fn` throws, NOTHING is
 * committed and the partial ops stay pending on the doc, for the caller's
 * converging write (document-sync-session's `writeSpatialCanvas(doc, next)`
 * fallback) to absorb into one commit.
 */
export function withDocumentBatch(
  doc: DocumentContainers,
  fn: (writer: DocumentBatchWriter) => void,
): void {
  let wrote = false
  const writer: DocumentBatchWriter = {
    setProposedChangeStatus(proposalId, changeId, status) {
      setProposedChangeStatusInto(doc, proposalId, changeId, status)
      wrote = true
    },
    writeSpatialCanvas(canvas) {
      writeSpatialCanvasInto(doc, canvas)
      wrote = true
    },
    writeMarkdownBody(body) {
      writeMarkdownBodyInto(doc, body)
      wrote = true
    },
  }
  fn(writer)
  if (wrote) doc.commit()
}
