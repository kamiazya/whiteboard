/**
 * Copy a daemon-kept document, client-side, through the endpoints that
 * already exist: read the source's snapshot, create the copy, write the bytes
 * into it, then give it a name.
 *
 * One definition for both surfaces that offer the verb — the index row menu
 * and the document page — because the ORDER and the CREATE's `kind` are the
 * contract and neither is visible from a call site. The create is the only
 * place a stored kind is set (the write below is a plain re-save that never
 * touches one), so a call that omits it files a markdown note as a canvas:
 * that was a real defect, closed by #1767, and a second hand-written copy of
 * this sequence is how it would come back.
 *
 * Deliberately NOT doing the collision derivation itself: the two callers know
 * different lists (the index knows the workspace's rows, the document page
 * knows the switcher's documents) and passing what each holds keeps this free
 * of a list-loading policy.
 */
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import {
  createDocument,
  getDocumentSnapshot,
  setDocumentDisplayName,
  updateDocument,
} from './daemon-api-client.js'
import { deriveCopyName } from './derive-copy-name.js'
import { deriveCopyPath } from './derive-copy-path.js'

export interface DuplicateDaemonDocumentRequest {
  readonly fetch: typeof globalThis.fetch
  readonly daemonBaseUrl: string
  readonly workspaceId: string
  readonly sourcePath: string
  /** The SOURCE's kind. The copy is created as this, or it is created wrong. */
  readonly kind: DocumentKind
  /** The source's display name; the copy's is derived from it. */
  readonly displayName: string
  readonly existingPaths: readonly string[]
  readonly existingNames: readonly string[]
}

export interface DuplicatedDaemonDocument {
  readonly path: string
  readonly name: string
}

export async function duplicateDaemonDocument(
  request: DuplicateDaemonDocumentRequest,
): Promise<DuplicatedDaemonDocument> {
  const { fetch, daemonBaseUrl, workspaceId, sourcePath } = request
  const snapshot = await getDocumentSnapshot(fetch, daemonBaseUrl, workspaceId, sourcePath)
  const created = await createDocument(
    fetch,
    daemonBaseUrl,
    workspaceId,
    deriveCopyPath(sourcePath, request.existingPaths),
    request.kind,
  )
  await updateDocument(fetch, daemonBaseUrl, workspaceId, created.path, snapshot)
  const name = deriveCopyName(request.displayName, request.existingNames)
  await setDocumentDisplayName(fetch, daemonBaseUrl, workspaceId, created.path, name)
  return { path: created.path, name }
}
