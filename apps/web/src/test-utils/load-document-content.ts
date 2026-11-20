import { LoroDoc } from 'loro-crdt'
import { loadDocument } from '../lib/workspace-content.js'

/**
 * A document's current content as a standalone Loro document a test can
 * inspect, or null when the workspace tree does not hold it. Production reads
 * typed content through `loadDocument`; this opens the projection bytes it
 * hands a layout worker.
 */
export async function loadDocumentContent(
  documentId: string,
  options: { readonly dbName?: string } = {},
): Promise<LoroDoc | null> {
  const bytes = await loadDocument(documentId, async (held) => held.projection(), options)
  if (bytes === null) return null
  const doc = new LoroDoc()
  doc.import(bytes)
  return doc
}
