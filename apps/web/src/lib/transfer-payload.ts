/**
 * What a cross-origin transfer carries, read from this browser's own record.
 *
 * Separate from `send-transfer.ts` so the handshake stays free of loro: the
 * handshake is what a click has to reach synchronously (a popup blocker
 * refuses a `window.open` that follows an await), and this is the read that
 * runs while the destination loads. It is loaded lazily by its caller for
 * the same reason `promote-workspace.ts` is — loro stays behind the lazy
 * chunks (`entry-graph-loro-free.test.ts`).
 */
import { readWorkspaceDocuments } from '@kamiazya/whiteboard-loro-adapter'
import type { WorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import type { TransferPayload } from './send-transfer.js'

export async function readTransferPayload(workspaceDocs: WorkspaceDocs): Promise<TransferPayload> {
  const sourceWorkspaceId = getBrowserWorkspaceId()
  const record = await workspaceDocs.open(sourceWorkspaceId)
  if (record === null) throw new Error('This browser keeps no workspace record to send.')
  return {
    snapshot: new Uint8Array(record.export({ mode: 'snapshot' })),
    documentCount: readWorkspaceDocuments(record).length,
    sourceWorkspaceId,
  }
}
