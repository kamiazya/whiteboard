import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { Loro } from 'loro-crdt'
import type { IdbDocumentIndex } from '../lib/idb-document-index.js'
import { IdbDefaultDocumentPointer } from '../lib/local-document-summary.js'
import { LoroStore } from '../lib/loro-store.js'

/**
 * Seeds one document into the real browser stores, the way the app's own
 * create path does: an index row, a content record, and (optionally) the
 * default pointer.
 *
 * A browser test cannot hand-write an id any more — the index mints it — so
 * this returns the one it assigned. That is also why the content record is
 * written here rather than by the caller: it is keyed by that id, and a test
 * that seeds only the index gets a document with no last-edited time and no
 * bytes to open.
 */
export async function seedIdbDocument(
  index: IdbDocumentIndex,
  {
    path,
    name,
    kind = 'spatial',
    makeDefault = false,
  }: { path: string; name?: string; kind?: DocumentKind; makeDefault?: boolean },
): Promise<string> {
  await index.createWorkspace({ workspaceId: 'local' })
  const entry = await index.createDocument({
    workspaceId: 'local',
    path,
    kind,
    ...(name === undefined ? {} : { name }),
  })
  await new LoroStore().save(entry.documentId, new Loro().export({ mode: 'snapshot' }))
  if (makeDefault) await new IdbDefaultDocumentPointer().set(entry.documentId)
  return entry.documentId
}
