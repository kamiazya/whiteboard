import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { BrowserDocumentIndex } from '../lib/browser-document-index.js'
import { IdbDefaultDocumentPointer } from '../lib/browser-document-summary.js'
import { createSeededDocumentAt } from '../lib/create-seeded-document.js'
import { LoroStore } from '../lib/loro-store.js'

/**
 * Seeds one empty document in the real browser stores, through the same
 * create every surface uses — a node in the workspace tree and its listing
 * clock — and (optionally) the default pointer.
 *
 * Returns the id the document was minted with.
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
  const entry = await createSeededDocumentAt(new BrowserDocumentIndex(), new LoroStore(), {
    path,
    kind,
    ...(name === undefined ? {} : { name }),
  })
  if (makeDefault) await new IdbDefaultDocumentPointer().set(entry.documentId)
  return entry.documentId
}
