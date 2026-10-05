import { importWithinTextLimits, readWorkspaceDocuments } from '@kamiazya/whiteboard-loro-adapter'
import {
  documentPathSchema,
  MARKDOWN_MAX_CHARS,
  NODE_TEXT_MAX_CHARS,
} from '@kamiazya/whiteboard-model'
import type { Frontiers, LoroDoc } from 'loro-crdt'
import {
  type CachedTarget,
  DocumentEngineTrapError,
  runEvictingOnEngineTrap,
} from '../document-io.js'
import { getLogger } from '../log.js'

const log = getLogger('sync-write-limit')

/**
 * A sync write refused because of what its bytes would do to a body: insert
 * one piece longer than `MARKDOWN_MAX_CHARS`, or leave a markdown body longer
 * than that and longer than it was. Nothing of the write was kept.
 */
export class MarkdownBodyTooLargeError extends Error {
  constructor(
    public readonly shape: 'run' | 'body',
    public readonly chars: number,
  ) {
    super(
      shape === 'run'
        ? `This update inserts ${chars} characters in one piece, past the ${MARKDOWN_MAX_CHARS}-character limit for one write; split the content across documents`
        : `This update would make a document body ${chars} characters long, past the ${MARKDOWN_MAX_CHARS}-character limit for one document; split the content across documents`,
    )
    this.name = 'MarkdownBodyTooLargeError'
  }
}

/**
 * A sync write refused because it would add or grow a node's text past
 * `NODE_TEXT_MAX_CHARS` — the bound every tool write already holds, since
 * each read of the canvas lays that text out again. Nothing of the write was
 * kept; a node stored longer before the bound still takes an edit that does
 * not grow it.
 */
export class NodeTextTooLargeError extends Error {
  constructor(
    public readonly nodeId: string,
    public readonly chars: number,
  ) {
    super(
      `This update would give node ${JSON.stringify(nodeId)} ${chars} characters of text, past the ${NODE_TEXT_MAX_CHARS}-character limit for one node; split it across nodes, or put it in a markdown document and embed that`,
    )
    this.name = 'NodeTextTooLargeError'
  }
}

/**
 * A sync write refused because it would put documents at paths the
 * document-path grammar refuses — a path every listing and search of the
 * workspace then fails on. Nothing of the write was kept.
 */
export class OffGrammarPathError extends Error {
  constructor(public readonly paths: readonly string[]) {
    const quoted = paths.map((path) => JSON.stringify(path)).join(', ')
    super(
      `This update would put documents at paths this keeper cannot store: ${quoted}. A path segment may hold only ASCII letters, digits and interior hyphens`,
    )
    this.name = 'OffGrammarPathError'
  }
}

/** A throw the sync write raises on purpose and its caller answers, not a refused import. */
export function isSyncWriteRefusal(err: unknown): boolean {
  return (
    err instanceof DocumentEngineTrapError ||
    err instanceof MarkdownBodyTooLargeError ||
    err instanceof NodeTextTooLargeError ||
    err instanceof OffGrammarPathError
  )
}

function refuse(
  target: CachedTarget,
  error: MarkdownBodyTooLargeError | NodeTextTooLargeError | OffGrammarPathError,
): never {
  target.evict()
  log.warning('sync write refused', { ...target.fields, reason: error.message })
  throw error
}

/** Where each document of a workspace record sits, by id. */
function pathsById(doc: LoroDoc): Map<string, string> {
  return new Map(readWorkspaceDocuments(doc).map((entry) => [entry.documentId, entry.path]))
}

/**
 * The paths the update MOVED a document onto that the grammar refuses. A
 * document already at such a path and left there is not the update's doing,
 * and moving it off one is how it gets repaired, so both are let through.
 *
 * One walk of the tree in the usual case — no path off the grammar at all.
 * Only when one is found is the state taken back to `before` for a second
 * walk, which costs re-applying this update: that is the rare case of a
 * workspace still holding a path written before the grammar was enforced.
 */
function newOffGrammarPaths(doc: LoroDoc, before: Frontiers, target: CachedTarget): string[] {
  const offGrammar = [...pathsById(doc)].filter(
    ([, path]) => !documentPathSchema.safeParse(path).success,
  )
  if (offGrammar.length === 0) return []
  doc.checkout(before)
  const earlier = pathsById(doc)
  runEvictingOnEngineTrap(target, 'importing an update into', () => doc.attach())
  return offGrammar
    .filter(([documentId, path]) => earlier.get(documentId) !== path)
    .map(([, path]) => path)
}

/**
 * Imports a client's update into a CACHED document unless it breaks the
 * markdown size limit, the node-text limit or, for a workspace record, the
 * document-path grammar — in which case nothing of it is kept.
 *
 * What the update does to text is `importWithinTextLimits`'s judgement, the
 * one the browser keeper takes too; this adds what only the daemon's sync
 * surface owes, the path grammar. Paths are checked only for an update that
 * writes a workspace node's meta or moves one, and then by one walk of the
 * tree (`newOffGrammarPaths`); a body edit pays nothing for them.
 *
 * Every refusal drops the cached instance instead of saving, so the next
 * read rebuilds it from storage and nothing of the write survives.
 * Everything from the import to the refusal is synchronous, so no other
 * request sees the half-taken state.
 */
export function importWithinSyncLimits(
  doc: LoroDoc,
  update: Uint8Array,
  target: CachedTarget,
  options: { readonly workspaceRecord: boolean },
): void {
  const before = doc.oplogFrontiers()
  const trapped = { ...target, fields: { ...target.fields, updateBytes: update.byteLength } }
  const { breach, touchesNodeMeta } = runEvictingOnEngineTrap(
    trapped,
    'importing an update into',
    () => importWithinTextLimits(doc, update),
  )
  if (breach?.shape === 'node-text') {
    refuse(target, new NodeTextTooLargeError(breach.nodeId, breach.chars))
  }
  if (breach !== null) refuse(target, new MarkdownBodyTooLargeError(breach.shape, breach.chars))
  if (!(options.workspaceRecord && touchesNodeMeta)) return
  const offGrammar = newOffGrammarPaths(doc, before, trapped)
  if (offGrammar.length > 0) refuse(target, new OffGrammarPathError(offGrammar))
}
