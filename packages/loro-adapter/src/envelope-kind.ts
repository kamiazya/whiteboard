// A document's kind is recorded twice: on its workspace node, where it is
// placement, and in its envelope, which travels with the content. Readers
// take the envelope's word first (`readDocumentKind(doc) ?? entry.kind`), so
// a sync update rewriting it would make a board read as a note and disarm
// every guard that keeps a markdown write off a board's nodes. The envelope
// may therefore say only what the node records — which still lets an
// unkinded document be claimed as its own kind, the way a keeper claims one.
import { type DocumentKind, documentKindSchema } from '@kamiazya/whiteboard-model'
import { type ContainerID, type LoroDoc, LoroMap, type TreeID } from 'loro-crdt'
import { DOCUMENT_KEY } from './containers.js'
import { WORKSPACE_TREE_KEY } from './workspace-tree.js'

/** An envelope an update left saying another kind than its document records. */
export interface EnvelopeKindBreach {
  /** The envelope map. */
  readonly container: ContainerID
  /** The kind the document records: its node's, or the caller's for a standalone document. */
  readonly recorded: DocumentKind
  /** What the envelope says now; `undefined` for nothing, or for a value no kind parses as. */
  readonly kind: DocumentKind | undefined
  /** The document's id, when the envelope sits under a workspace node. */
  readonly documentId?: string
}

const parsedKind = (value: unknown): DocumentKind | undefined => {
  const parsed = documentKindSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/** The kind and id the node at `id` records, or `null` when there is no such node. */
function nodeRecord(doc: LoroDoc, id: TreeID) {
  const node = doc.getTree(WORKSPACE_TREE_KEY).getNodeByID(id)
  if (node === undefined) return null
  const documentId = node.data.get('documentId')
  return {
    recorded: parsedKind(node.data.get('kind')),
    documentId: typeof documentId === 'string' ? documentId : undefined,
  }
}

/**
 * A node whose own `kind` an update rewrote, left disagreeing with the kind
 * its envelope already states. The node's copy is placement, but changing it
 * under a kinded envelope splits the two copies just as rewriting the
 * envelope does; a node created with its kind, or one whose envelope states
 * none, is not judged here.
 */
function nodeKindBreach(doc: LoroDoc, id: TreeID): EnvelopeKindBreach | null {
  const node = doc.getTree(WORKSPACE_TREE_KEY).getNodeByID(id)
  if (node === undefined) return null
  const envelope = node.data.get(DOCUMENT_KEY)
  if (!(envelope instanceof LoroMap)) return null
  const stated = parsedKind(envelope.get('kind'))
  if (stated === undefined) return null
  const recorded = parsedKind(node.data.get('kind'))
  if (recorded === stated) return null
  const documentId = node.data.get('documentId')
  return {
    container: envelope.id,
    recorded: stated,
    kind: recorded,
    ...(typeof documentId === 'string' ? { documentId } : {}),
  }
}

/**
 * The first envelope among the maps an update wrote a `kind` key in that it
 * left disagreeing with the kind its document records — judged on `doc`'s
 * state once the update is in, so a write a concurrent one outranked is
 * judged by what readers will see.
 *
 * An envelope at the document's root is held to `recordedAtRoot`, the kind
 * the keeper records for a standalone document; `null` for one it records
 * none for, which is a document being created and may take any kind. One
 * under a workspace node is held to that node's `kind`. A node recording no
 * kind it can read is the placement checks' to refuse, not this one's.
 */
export function envelopeKindBreach(
  doc: LoroDoc,
  written: ReadonlySet<ContainerID>,
  recordedAtRoot: DocumentKind | null,
): EnvelopeKindBreach | null {
  for (const container of written) {
    const path = doc.getPathToContainer(container)
    if (path === undefined) continue
    const breach =
      path.length === 2 && path[0] === WORKSPACE_TREE_KEY
        ? nodeKindBreach(doc, path[1] as TreeID)
        : writtenEnvelopeBreach(doc, container, path, recordedAtRoot)
    if (breach !== null) return breach
  }
  return null
}

/** `container`, an envelope the update wrote, left disagreeing with its document's recorded kind. */
function writtenEnvelopeBreach(
  doc: LoroDoc,
  container: ContainerID,
  path: ReadonlyArray<unknown>,
  recordedAtRoot: DocumentKind | null,
): EnvelopeKindBreach | null {
  if (path.at(-1) !== DOCUMENT_KEY) return null
  let record: { recorded: DocumentKind | undefined; documentId?: string | undefined } | null
  if (path.length === 1) record = { recorded: recordedAtRoot ?? undefined }
  else if (path.length === 3 && path[0] === WORKSPACE_TREE_KEY) {
    record = nodeRecord(doc, path[1] as TreeID)
  } else return null
  if (record?.recorded === undefined) return null
  const kind = parsedKind((doc.getContainerById(container) as LoroMap).get('kind'))
  if (kind === record.recorded) return null
  return {
    container,
    recorded: record.recorded,
    kind,
    ...(record.documentId === undefined ? {} : { documentId: record.documentId }),
  }
}

/**
 * A standalone document whose envelope STATES a kind other than `recorded` —
 * for a state written back whole, such as a restored version, rather than an
 * update: an envelope stating nothing defers to the record and is no split.
 * A document with no envelope is not given one by asking.
 */
export function statedKindSplit(
  doc: LoroDoc,
  recorded: DocumentKind | null | undefined,
): EnvelopeKindBreach | null {
  if (recorded === null || recorded === undefined) return null
  if (!Object.hasOwn(doc.getShallowValue(), DOCUMENT_KEY)) return null
  const envelope = doc.getMap(DOCUMENT_KEY)
  const stated: unknown = envelope.get('kind')
  if (stated === undefined) return null
  const kind = parsedKind(stated)
  return kind === recorded ? null : { container: envelope.id, recorded, kind }
}
