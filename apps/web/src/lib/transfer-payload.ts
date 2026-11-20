/**
 * What a cross-origin transfer carries, read from this browser's own record.
 *
 * Separate from `send-transfer.ts` so the handshake stays free of loro: the
 * handshake is what a click has to reach synchronously (a popup blocker
 * refuses a `window.open` that follows an await), and this is the read that
 * runs while the destination loads. It is loaded lazily by its caller for
 * the same reason `promote-workspace.ts` is — the engine stays behind the lazy
 * chunks (`entry-graph-loro-free.test.ts`).
 *
 * Beside the record go the trash bytes and saved versions, read and fitted
 * by `carried-planes.ts` exactly as a promote reads and fits them: the
 * receiver posts them on to its keeper's promote, under the same ceiling.
 */
import {
  lease,
  type RecordLease,
  type WorkspaceDocumentEntry,
} from '@kamiazya/whiteboard-loro-adapter'
import { bytesToBase64Url } from '@kamiazya/whiteboard-model'
import type { WorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { z } from 'zod'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { fitCarriedPlanes, readCarriedPlanes } from './carried-planes.js'
import type { TransferPayload } from './send-transfer.js'

// The reader is total over this shape; the parse asserts the type only.
const documentsShape = z.custom<WorkspaceDocumentEntry[]>()

export async function readTransferPayload(
  workspaceDocs: WorkspaceDocs<RecordLease>,
): Promise<TransferPayload> {
  const sourceWorkspaceId = getBrowserWorkspaceId()
  const record = await workspaceDocs.open(sourceWorkspaceId)
  if (record === null) throw new Error('This browser keeps no workspace record to send.')
  return lease.withLease(record, async (held) => {
    const snapshot = lease.exportSnapshot(held)
    const planes = await readCarriedPlanes(held, sourceWorkspaceId)
    const fitted = fitCarriedPlanes(bytesToBase64Url(snapshot), planes)
    const documents = await lease.read(held, { query: 'documents' }, documentsShape)
    return {
      snapshot,
      documentCount: documents.length,
      sourceWorkspaceId,
      trash: fitted.trash,
      versions: fitted.versions,
      leftBehind: [...planes.leftBehind, ...fitted.leftBehind],
    }
  })
}
