import {
  createWorkspaceDocumentAtPath,
  type DocumentContainers,
  documentContainers,
} from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { applyWorkspaceDocumentUpdate } from '../operations/apply-workspace-document-update.js'
import type { LiveDocuments, WorkspaceDocuments } from '../server-deps.js'
import type { StoredDoc } from './stored-doc.js'
import { unusedBlobStore } from './unused-blob-store.js'
import { unusedLiveDocuments } from './unused-live-documents.js'
import { unusedWorkspaceDocuments } from './unused-workspace-documents.js'

/** The one document a `recordHolding` record holds. */
const RECORD_DOCUMENT_ID = '01BRWAAAAAAAAAAAAAAAAAAAB0'

/** A workspace record holding one document at `doc`, its content written by `fill`. */
export function recordHolding(
  fill: (content: DocumentContainers) => void = () => {},
  kind: DocumentKind = 'spatial',
): LoroDoc {
  const record = new LoroDoc()
  createWorkspaceDocumentAtPath(record, { path: 'doc', documentId: RECORD_DOCUMENT_ID, kind })
  fill(documentContainers(record, RECORD_DOCUMENT_ID))
  record.commit()
  return record
}

/** That document's content, in `record`. */
export function contentOf(record: LoroDoc): DocumentContainers {
  return documentContainers(record, RECORD_DOCUMENT_ID)
}

/**
 * What an editor holding `store`'s record sends after `edit` of its one
 * document, applied through the workspace-record sync path — the only one a
 * sync write takes.
 */
export function sendRecordEdit(store: StoredDoc, edit: (content: DocumentContainers) => void) {
  const workspaceDocuments: WorkspaceDocuments = {
    ...unusedWorkspaceDocuments(),
    get: async () => store.get(),
    save: async (_workspaceId, saved) => store.save(saved),
    evict: () => store.evict(),
    evictProjections: () => {},
  }
  const liveDocuments: LiveDocuments = {
    ...unusedLiveDocuments(),
    withWriteLock: (_workspaceId, fn) => fn(),
  }
  const client = store.get().fork()
  const from = client.oplogVersion()
  edit(contentOf(client))
  client.commit()
  return applyWorkspaceDocumentUpdate(
    { liveDocuments, workspaceDocuments, blobStore: unusedBlobStore() },
    { workspaceId: 'ws-1', update: client.export({ mode: 'update', from }) },
  )
}
