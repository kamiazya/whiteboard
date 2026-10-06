import type { DocumentContent } from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { tagBearersOf } from '@kamiazya/whiteboard-reference-graph'
import type { LoroDoc } from 'loro-crdt'
import type { WorkspaceDocumentEntry } from './document-entry.js'

type TagBearers = ReturnType<typeof tagBearersOf>

/** One document read from the store, with its content already read as the half its kind names. */
export interface ReadDocument {
  documentId: string
  doc: LoroDoc
  content: DocumentContent
}

/**
 * What a held set of bearers is valid FOR: the content stamp and the kind the
 * row names, since a document that records no kind is read as its row says.
 * Undefined for a document with no stamp, which is never held — nothing says
 * when it changed.
 */
function keyOf(entry: { kind?: DocumentKind }, stamp: string | undefined): string | undefined {
  return stamp === undefined ? undefined : `${entry.kind ?? '?'}:${stamp}`
}

type Held = ReadonlyMap<string, { key: string; bearers: TagBearers }>

/** The listed documents whose held bearers are still valid, and the ones that must be read. */
function partition(
  held: Held,
  entries: readonly WorkspaceDocumentEntry[],
  keys: ReadonlyMap<string, string | undefined>,
): { bearers: Map<string, TagBearers>; unread: WorkspaceDocumentEntry[] } {
  const bearers = new Map<string, TagBearers>()
  const unread: WorkspaceDocumentEntry[] = []
  for (const entry of entries) {
    const kept = held.get(entry.documentId)
    if (kept !== undefined && kept.key === keys.get(entry.documentId)) {
      bearers.set(entry.documentId, kept.bearers)
    } else {
      unread.push(entry)
    }
  }
  return { bearers, unread }
}

/**
 * What each listed document bears, kept per document until its content stamp
 * or its row's kind moves — the listing's tag chips and the vocabulary in use
 * both read it.
 *
 * Without it every list reloads and parses EVERY document. The stamp is a
 * millisecond timestamp, so two writes inside one millisecond read as one,
 * which the corpus already accepts.
 *
 * An unreadable document is not yielded by `read` and bears nothing here: it
 * lists tagless rather than failing the list, and is asked for again next time.
 * ponytail: the first list of a session still reads and parses every document;
 * persist the facts when that wait shows.
 */
export function createTagBearersCache(
  read: (entries: readonly WorkspaceDocumentEntry[]) => AsyncIterable<ReadDocument>,
): (
  entries: readonly WorkspaceDocumentEntry[],
  stamps: ReadonlyMap<string, string>,
) => Promise<Map<string, TagBearers>> {
  const held = new Map<string, { key: string; bearers: TagBearers }>()

  return async (entries, stamps) => {
    const keys = new Map(entries.map((e) => [e.documentId, keyOf(e, stamps.get(e.documentId))]))
    for (const id of held.keys()) if (!keys.has(id)) held.delete(id)

    const { bearers, unread } = partition(held, entries, keys)
    for await (const one of read(unread)) {
      const found = tagBearersOf(one.doc, one.content)
      bearers.set(one.documentId, found)
      const key = keys.get(one.documentId)
      if (key === undefined) held.delete(one.documentId)
      else held.set(one.documentId, { key, bearers: found })
    }
    return bearers
  }
}
