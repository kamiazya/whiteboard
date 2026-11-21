import type { DocumentEntry, DocumentIndex, DocumentStore } from '@kamiazya/whiteboard-ports'
import { reassembleSnapshot } from '@kamiazya/whiteboard-ports'

/**
 * Hex SHA-256 of `bytes`. Web Crypto, like the operations it stands in for:
 * this package runs unchanged where `node:crypto` does not exist.
 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes)),
  )
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * `index` with a content digest on every entry whose document has a stored
 * snapshot, as the daemon's listing has one on every entry. The digest is that
 * of the stored bytes, which moves whenever the document does: what the facts
 * cache needs of a stamp, without a content reader the in-memory index lacks.
 * An entry whose document stores nothing yet carries none, as a document with
 * nothing to digest would.
 */
export function withContentDigests(index: DocumentIndex, store: DocumentStore): DocumentIndex {
  // Bound now, so a test that spies on the store's loads counts its own and not these.
  const load = store.loadSnapshot?.bind(store)
  const stamp = async (workspaceId: string, entry: DocumentEntry): Promise<DocumentEntry> => {
    const stored =
      load === undefined
        ? null
        : await load({
            docRef: { kind: 'document', workspaceId, documentId: entry.documentId },
          })
    if (stored === null) return entry
    const contentDigest = await sha256Hex(reassembleSnapshot(stored.manifest, stored.chunks))
    return { ...entry, contentDigest }
  }
  return new Proxy(index, {
    get(target, property) {
      const member = Reflect.get(target, property, target)
      if (typeof member !== 'function') return member
      if (property === 'listDocuments') {
        return async (input: { workspaceId: string }) =>
          Promise.all(
            (await target.listDocuments(input as never)).map((entry) =>
              stamp(input.workspaceId, entry),
            ),
          )
      }
      if (property === 'resolveDocument' || property === 'resolveDocumentById') {
        return async (input: { workspaceId: string }) => {
          const entry = await (member as (input: unknown) => Promise<DocumentEntry | null>).call(
            target,
            input,
          )
          return entry === null ? null : stamp(input.workspaceId, entry)
        }
      }
      return member.bind(target)
    },
  })
}
