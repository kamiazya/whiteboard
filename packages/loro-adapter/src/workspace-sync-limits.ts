// What a daemon owes a sync update of a workspace record beyond the text
// limits: the update's changes must build on ones the record holds, an
// envelope may say only the kind its node records, and what the update does
// to the tree — how many documents and folders it holds, which nodes readers
// can still read, which paths and names the grammar accepts — must not
// worsen. Pure judges over a document and an update; what to answer, and what
// to do with the cached copy, is the keeper's.
import {
  DOCUMENT_NAME_MAX_LENGTH,
  DOCUMENT_PATH_MAX_LENGTH,
  type DocumentKind,
  documentPathSchema,
  folderNameRefusal,
  REFUSAL_CODES,
  type SyncWriteRefusalCode,
  WORKSPACE_MAX_DOCUMENTS,
  WORKSPACE_MAX_FOLDERS,
} from '@kamiazya/whiteboard-model'
import type { ContainerID, Frontiers, LoroDoc } from 'loro-crdt'
import { isEngineTrap } from './engine-trap.js'
import { envelopeKindBreach } from './envelope-kind.js'
import {
  importWithinTextLimits,
  type SyncTextBreach,
  UnjudgedImportError,
} from './sync-text-limits.js'
import { readWorkspaceNodes, unreadableWorkspaceNodes } from './workspace-tree.js'

/**
 * A refusal only a workspace record's sync owes. Declared with the same
 * discipline as `SyncTextBreach`: a shape per refusal, carrying what the
 * keeper's message names.
 */
export type WorkspaceSyncBreach =
  | { readonly shape: 'causal-gap' }
  | { readonly shape: 'too-many-documents'; readonly count: number }
  | { readonly shape: 'too-many-folders'; readonly count: number }
  | { readonly shape: 'unreadable-document-meta'; readonly nodes: readonly string[] }
  | { readonly shape: 'invalid-path'; readonly paths: readonly string[] }
  | { readonly shape: 'document-name-too-long'; readonly paths: readonly string[] }
  | {
      readonly shape: 'folder-name-refused'
      readonly paths: readonly string[]
      /** Why `folderNameRefusal` refused the first of them. */
      readonly reason: string
    }
  | {
      readonly shape: 'document-kind-changed'
      /** The envelope that disagrees, so a caller can name the document. */
      readonly container: ContainerID
      readonly recorded: DocumentKind
      readonly kind: DocumentKind | undefined
      readonly documentId?: string
    }

/** The code each workspace-sync refusal is answered with, beside `SYNC_TEXT_BREACH_CODES`. */
export const SYNC_WORKSPACE_BREACH_CODES = {
  'causal-gap': REFUSAL_CODES.causalGap,
  'too-many-documents': REFUSAL_CODES.tooManyDocuments,
  'too-many-folders': REFUSAL_CODES.tooManyFolders,
  'unreadable-document-meta': REFUSAL_CODES.unreadableDocumentMeta,
  'invalid-path': REFUSAL_CODES.invalidPath,
  'document-name-too-long': REFUSAL_CODES.documentNameTooLong,
  'folder-name-refused': REFUSAL_CODES.folderNameRefused,
  'document-kind-changed': REFUSAL_CODES.documentKindChanged,
} as const satisfies Record<WorkspaceSyncBreach['shape'], SyncWriteRefusalCode>

export function isWorkspaceSyncBreach(
  breach: SyncTextBreach | WorkspaceSyncBreach,
): breach is WorkspaceSyncBreach {
  return Object.hasOwn(SYNC_WORKSPACE_BREACH_CODES, breach.shape)
}

/**
 * What a workspace record's tree says about its nodes, as the placement
 * checks compare it. One entry per document NODE, never keyed by id: a
 * client can write a node carrying an id another node already has, and a
 * map by id would let the node tree-ordered last hide the rest — from the
 * ceiling's count and from the path and name checks alike.
 */
interface Placement {
  readonly documents: ReadonlyArray<{
    readonly documentId: string
    readonly path: string
    /** 0 for no name. */
    readonly nameLength: number
  }>
  /** Folders have no id, so a folder is known by its path. */
  readonly folders: readonly string[]
  /** Each named folder node's path and name, one entry per node. */
  readonly folderNames: ReadonlyArray<{ readonly path: string; readonly name: string }>
  /** The tree ids every listing skips, with their subtrees. */
  readonly unreadable: ReadonlySet<string>
}

/**
 * One walk of the tree, and no content digest: the placement checks read
 * where nodes sit and what they are called, never what documents say.
 */
function placementOf(doc: LoroDoc): Placement {
  const documents: Array<Placement['documents'][number]> = []
  const folders: string[] = []
  const folderNames: Array<Placement['folderNames'][number]> = []
  for (const node of readWorkspaceNodes(doc)) {
    if (node.type === 'folder') {
      folders.push(node.path)
      if (node.name !== undefined) folderNames.push({ path: node.path, name: node.name })
    } else
      documents.push({
        documentId: node.meta.documentId,
        path: node.path,
        nameLength: node.meta.name?.length ?? 0,
      })
  }
  return { documents, folders, folderNames, unreadable: new Set(unreadableWorkspaceNodes(doc)) }
}

/**
 * The length first, so a path a deep chain of folders made long is refused
 * without the grammar splitting it — a chain that deep holds as many such
 * paths as folders.
 */
const onGrammar = (path: string) =>
  path.length <= DOCUMENT_PATH_MAX_LENGTH && documentPathSchema.safeParse(path).success

const placedAt = (documentId: string, path: string) => `${documentId}\n${path}`

/** The longest name each id carried, so a long name is judged against its own past. */
function longestNames(placement: Placement): ReadonlyMap<string, number> {
  const longest = new Map<string, number>()
  for (const { documentId, nameLength } of placement.documents) {
    longest.set(documentId, Math.max(nameLength, longest.get(documentId) ?? 0))
  }
  return longest
}

/** The refused folder names the update wrote: one the record held before is not its doing. */
function folderNamesBreach(after: Placement, earlier: Placement): WorkspaceSyncBreach | null {
  const before = new Set(earlier.folderNames.map((f) => placedAt(f.path, f.name)))
  const written = after.folderNames.filter(
    (f) => folderNameRefusal(f.name) !== null && !before.has(placedAt(f.path, f.name)),
  )
  const [first] = written
  if (first === undefined) return null
  return {
    shape: 'folder-name-refused',
    paths: written.map(({ path }) => path),
    reason: folderNameRefusal(first.name) ?? '',
  }
}

/**
 * The refusal an update's placement writes earn: a record it grew past
 * `WORKSPACE_MAX_DOCUMENTS` or `WORKSPACE_MAX_FOLDERS`, a node it left
 * unreadable, a document or folder it put at a path the grammar refuses, or
 * a name it grew past the bound, or a folder name `folderNameRefusal`
 * refuses. What was already so before the update is
 * not its doing — and deleting documents, moving one off a bad path, or
 * shortening a long name is how it gets repaired — so each is judged against
 * the state before.
 *
 * A folder is held to the path grammar for the reason a document is, and for
 * one more: the length bound on its path is what bounds how deep the tree
 * goes, since every walk of the record is as deep as its deepest node.
 *
 * One walk of the tree in the usual case, where nothing is suspect. Only when
 * something is does the state go back to `before` for a second walk, which
 * costs re-applying this update: the rare case of a workspace still holding
 * data written before a bound was enforced, or a write that breaks one.
 */
function placementBreach(doc: LoroDoc, before: Frontiers): WorkspaceSyncBreach | null {
  const after = placementOf(doc)
  const offGrammar = after.documents.filter(({ path }) => !onGrammar(path))
  const offGrammarFolders = after.folders.filter((path) => !onGrammar(path))
  const longNames = after.documents.filter(
    ({ nameLength }) => nameLength > DOCUMENT_NAME_MAX_LENGTH,
  )
  const crowded = after.documents.length > WORKSPACE_MAX_DOCUMENTS
  const crowdedFolders = after.folders.length > WORKSPACE_MAX_FOLDERS
  if (
    !crowded &&
    !crowdedFolders &&
    offGrammar.length === 0 &&
    offGrammarFolders.length === 0 &&
    longNames.length === 0 &&
    !after.folderNames.some(({ name }) => folderNameRefusal(name) !== null) &&
    after.unreadable.size === 0
  )
    return null
  doc.checkout(before)
  const earlier = placementOf(doc)
  doc.attach()
  if (crowded && after.documents.length > earlier.documents.length) {
    return { shape: 'too-many-documents', count: after.documents.length }
  }
  if (crowdedFolders && after.folders.length > earlier.folders.length) {
    return { shape: 'too-many-folders', count: after.folders.length }
  }
  const unreadable = [...after.unreadable].filter((node) => !earlier.unreadable.has(node))
  if (unreadable.length > 0) return { shape: 'unreadable-document-meta', nodes: unreadable }
  const earlierPlaces = new Set(earlier.documents.map((d) => placedAt(d.documentId, d.path)))
  const earlierFolders = new Set(earlier.folders)
  const moved = [
    ...offGrammar
      .filter((d) => !earlierPlaces.has(placedAt(d.documentId, d.path)))
      .map((d) => d.path),
    ...offGrammarFolders.filter((path) => !earlierFolders.has(path)),
  ]
  if (moved.length > 0) return { shape: 'invalid-path', paths: moved }
  const earlierNames = longestNames(earlier)
  const grown = longNames.filter((d) => d.nameLength > (earlierNames.get(d.documentId) ?? 0))
  if (grown.length > 0) {
    return { shape: 'document-name-too-long', paths: grown.map(({ path }) => path) }
  }
  return folderNamesBreach(after, earlier)
}

/**
 * The breach an update earns for leaving an envelope it wrote a `kind` in
 * saying another kind than its document records. An update writing no
 * `kind` key pays nothing for it.
 */
function kindBreach(
  doc: LoroDoc,
  kindWrittenIn: ReadonlySet<ContainerID>,
): WorkspaceSyncBreach | null {
  if (kindWrittenIn.size === 0) return null
  const breach = envelopeKindBreach(doc, kindWrittenIn, null)
  if (breach === null) return null
  return {
    shape: 'document-kind-changed',
    container: breach.container,
    recorded: breach.recorded,
    kind: breach.kind,
    ...(breach.documentId === undefined ? {} : { documentId: breach.documentId }),
  }
}

/**
 * Imports a client's update into a workspace record and answers the first
 * thing it breaks, or `null` when it may be kept: a change it builds on that
 * the record lacks (judged first, since a parked change was judged by
 * nothing below), then `importWithinTextLimits`'s text bounds, the kind its
 * envelopes may say, and — only for an update that writes a node's meta or
 * moves one — the placement checks. A body edit pays nothing for those.
 *
 * On a breach `doc` holds operations it must not keep: the caller discards
 * the instance. The errors are `importWithinTextLimits`'s: bytes the engine
 * refuses leave `doc` as it was, a trap is rethrown as it came, and anything
 * thrown once the update has landed is an `UnjudgedImportError`.
 */
export function judgeWorkspaceSyncImport(
  doc: LoroDoc,
  update: Uint8Array,
): SyncTextBreach | WorkspaceSyncBreach | null {
  const before = doc.oplogFrontiers()
  const { breach, touchesNodeMeta, kindWrittenIn, pending } = importWithinTextLimits(doc, update)
  try {
    if (pending) return { shape: 'causal-gap' }
    if (breach !== null) return breach
    const kind = kindBreach(doc, kindWrittenIn)
    if (kind !== null) return kind
    return touchesNodeMeta ? placementBreach(doc, before) : null
  } catch (err) {
    if (isEngineTrap(err)) throw err
    throw new UnjudgedImportError(err)
  }
}
