import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { Loro } from 'loro-crdt'
import { IdbDefaultDocumentPointer } from '../lib/browser-document-summary.js'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { LoroStore } from '../lib/loro-store.js'
import { seedLegacyRow } from './seed-legacy-row.js'

/**
 * Seeds one document the way an older build left it in the real browser
 * stores: a legacy index row, a per-document content record, and
 * (optionally) the default pointer. The startup fold moves it into the
 * workspace tree on first read, which is the path a returning user's
 * documents take.
 *
 * Returns the id the row was minted with. The content record is written
 * here rather than by the caller because it is keyed by that id, and a test
 * that seeds only the row gets a document with no last-edited time and no
 * bytes to open.
 */
export async function seedIdbDocument({
  path,
  name,
  kind = 'spatial',
  makeDefault = false,
}: {
  path: string
  name?: string
  kind?: DocumentKind
  makeDefault?: boolean
}): Promise<string> {
  const entry = await seedLegacyRow({
    workspaceId: getBrowserWorkspaceId(),
    path,
    kind,
    ...(name === undefined ? {} : { name }),
  })
  await new LoroStore().save(entry.documentId, new Loro().export({ mode: 'snapshot' }))
  if (makeDefault) await new IdbDefaultDocumentPointer().set(entry.documentId)
  return entry.documentId
}
