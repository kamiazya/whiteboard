import {
  createReferenceContentAccount,
  type LoadedReference,
  type ReferenceContentAccount,
} from '@kamiazya/whiteboard-canvas-render'
import { readDocumentContent } from '@kamiazya/whiteboard-loro-adapter'
import { documentIdSchema, documentPathSchema, type WorkspaceId } from '@kamiazya/whiteboard-model'
import type { DocumentEntry } from '@kamiazya/whiteboard-ports'
import { reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import type { ServerDeps } from '../server-deps.js'

/**
 * Resolves one reference to the document it names.
 *
 * References are resolved by LOOKUP rather than by shape: a document id and
 * a document path are both plain strings whose alphabets overlap, so an id
 * that happens to look like a path (or the reverse) must not be decided by a
 * regex. The id lookup is tried first because a file node written today
 * stores an id — a path would dangle the moment the document moved — and
 * because the reader gives `[[<id>]]` the same precedence.
 */
async function resolveDocumentEntry(
  deps: ServerDeps,
  workspaceId: WorkspaceId,
  ref: string,
): Promise<DocumentEntry | null> {
  if (documentIdSchema.safeParse(ref).success) {
    const byId = await deps.documentIndex.resolveDocumentById({
      workspaceId,
      documentId: ref,
    })
    if (byId !== null) return byId
  }
  if (!documentPathSchema.safeParse(ref).success) return null
  return await deps.documentIndex.resolveDocument({ workspaceId, path: ref })
}

/**
 * The daemon's half of reference resolution for ONE walk: reach the store
 * for each reference and answer canvas-render's `LoadedReference`.
 * Everything that decides what the record MEANS — which seam draws what — is
 * the shared `referenceSeams`, so this is only I/O, and the bound on it.
 *
 * `null` when nothing is indexed under the reference. A document whose
 * snapshot is gone still answers its name (its path when it has none), so the card can say what it
 * pointed at. Only a MARKDOWN document yields a body and only a SPATIAL one
 * a canvas; the kind comes from the document itself rather than the index
 * row, because the format follows from the document (ADR-0009 decision 4)
 * and the index's `kind` is absent on rows that predate it. A markdown
 * document's stored content is also a valid canvas holding one text node,
 * so "does it parse as a canvas" cannot tell the two apart.
 *
 * The walk's target budget counts strings, and a string is priced by the
 * document it names, so the loader holds two bounds of its own:
 *
 * - ONE read per document. Its id and its path are two targets naming one
 *   document; both answer the same record, from the same read.
 * - canvas-render's content account. A read is decoded only while the
 *   account is open, and a document past it answers its name. Reads run one
 *   at a time in the order the walk asked for them — the lookups before
 *   them stay concurrent — because the account can only be consulted before
 *   a read if the reads before it have been charged, and that order is what
 *   makes the same board load the same references on every call. The decode
 *   is CPU on the serving loop either way, so serialising it costs the
 *   overlap of store I/O and nothing else.
 */
export function createReferencedDocumentLoader(
  deps: ServerDeps,
  workspaceId: WorkspaceId,
): (ref: string) => Promise<LoadedReference | null> {
  const account = createReferenceContentAccount()
  const byDocument = new Map<string, Promise<LoadedReference>>()
  let previous: Promise<unknown> = Promise.resolve()

  const read = (entry: DocumentEntry): Promise<LoadedReference> => {
    const known = byDocument.get(entry.documentId)
    if (known !== undefined) return known
    const loaded = readReferencedDocument(deps, workspaceId, entry, account)
    byDocument.set(entry.documentId, loaded)
    return loaded
  }

  return (ref) => {
    const resolved = resolveDocumentEntry(deps, workspaceId, ref)
    // Observed now, so a lookup that fails while an earlier read is pending is
    // not an unhandled rejection; the turn below still rethrows it to its caller.
    resolved.catch(() => undefined)
    const turn = previous.then(async () => {
      const entry = await resolved
      return entry === null ? null : await read(entry)
    })
    previous = turn.catch(() => undefined)
    return turn
  }
}

async function readReferencedDocument(
  deps: ServerDeps,
  workspaceId: WorkspaceId,
  entry: DocumentEntry,
  account: ReferenceContentAccount,
): Promise<LoadedReference> {
  // The web labels a document `displayName ?? path`; an unnamed document (what
  // an agent creates) must read the same here rather than as its raw id.
  const named = { documentId: entry.documentId, name: entry.name ?? entry.path }
  if (account.closed) return named

  const snapshot = await deps.documentStore.loadSnapshot({
    docRef: { kind: 'document', workspaceId, documentId: entry.documentId },
  })
  if (snapshot === null) return named

  const doc = new LoroDoc()
  doc.import(reassembleSnapshot(snapshot.manifest, snapshot.chunks))
  const content = readDocumentContent(doc, entry.kind)
  return account.admit({
    ...named,
    ...(content.kind === 'markdown' ? { body: content.body } : { canvas: content.canvas }),
  })
}
