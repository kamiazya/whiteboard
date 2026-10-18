import {
  holdsContainerCreation,
  readWorkspaceDocuments,
  WORKSPACE_TREE_KEY,
} from '@kamiazya/whiteboard-loro-adapter'
import { type ContainerID, LoroDoc, LoroText, type TreeID } from 'loro-crdt'
import { DocumentEngineTrapError, runEvictingOnEngineTrap } from '../document-io.js'
import type { ServerDeps } from '../server-deps.js'
import type { OperatorInfo } from '../versions/version-entry.js'
import { TooManyVersionsError } from '../versions/version-refusal.js'
import { applyWorkspaceDocumentUpdate } from './apply-workspace-document-update.js'
import {
  type CarriedTrashBytes,
  type CarriedVersion,
  judgeCarried,
  storeCarriedTrash,
} from './promote-carried.js'
import {
  TextBreachRefusalError,
  textBreachRefusal,
  WORKSPACE_MAX_DOCUMENTS,
} from './sync-write-refusals.js'

export interface PromoteWorkspaceInput {
  readonly workspaceId: string
  /** The browser keeper's whole record, as a Loro snapshot. */
  readonly snapshot: Uint8Array
  /** The person who promoted, as the route states them (ADR-0039 decision 8). */
  readonly operator: OperatorInfo
  /** Evacuated bytes for the record's trash entries; see `promote-carried.ts`. */
  readonly trash?: readonly CarriedTrashBytes[]
  /** The versions the browser keeper saved of the record's documents. */
  readonly versions?: readonly CarriedVersion[]
}

export type PromoteWorkspaceResult =
  | { kind: 'malformed-snapshot' }
  /** The record holds more documents than a promote carries; nothing was merged. */
  | { kind: 'too-many-documents'; documents: number; limit: number }
  /** What was carried beside the record does not match it; nothing was merged. */
  | { kind: 'unmatched-carried'; reason: string }
  /** More trash entries or versions than a promote carries; nothing was judged or merged. */
  | { kind: 'too-many-carried'; plane: 'trash' | 'versions'; carried: number; limit: number }
  | {
      kind: 'promoted'
      /**
       * The documents the record carried that now have an explicit checkpoint.
       * A document whose history is already full keeps the merged content and
       * is left out: its point would pass the manual-version ceiling.
       */
      recorded: readonly string[]
      /**
       * Documents that arrived shadowed — the target already held another
       * document at their path. No checkpoint is written for them: a
       * version row is addressed by PATH and would name the document that
       * won the address, which is not the one that was promoted.
       */
      shadowed: readonly string[]
      /** Trash entries whose bytes the daemon now holds, read back from the blob store. */
      trashStored: readonly string[]
      /** Carried version ids the daemon's history holds, read back from it. */
      versionsKept: readonly string[]
    }

/**
 * The promoted document `container` lives under, or `undefined` when it is not
 * inside one — a body, a canvas's node or edge map, or a thread's messages
 * each sit below their document's workspace-tree node, and a content key
 * holding the wrong kind is named by the node's own map.
 */
function promotedDocumentAt(
  incoming: LoroDoc,
  container: ContainerID,
): { readonly path: string } | undefined {
  const path = incoming.getPathToContainer(container)
  if (path === undefined || path.length < 2 || path[0] !== WORKSPACE_TREE_KEY) return undefined
  const node = incoming.getTree(WORKSPACE_TREE_KEY).getNodeByID(path[1] as TreeID)
  const documentId = node?.data.get('documentId')
  return readWorkspaceDocuments(incoming).find((each) => each.documentId === documentId)
}

/**
 * A size refusal from the merge, re-raised naming the promoted document it is
 * about. The merge sees only a container and a key; the promoted record is
 * what can say which document holds it — a canvas a person can open, rather
 * than a node id they never see — and, for a body, how long it is now, which
 * for a run found only in the history tells a person the document they see is
 * not the problem.
 */
function namedInRecord(incoming: LoroDoc, err: unknown): unknown {
  if (!(err instanceof TextBreachRefusalError)) return err
  const { container } = err.breach
  // A container whose creating op the record lacks has no parent, and asking
  // the engine for its path panics rather than answering `undefined`.
  if (!holdsContainerCreation(incoming, container)) return err
  const entry = promotedDocumentAt(incoming, container)
  if (entry === undefined) return err
  const held = incoming.getContainerById(container)
  return textBreachRefusal(err.breach, {
    path: entry.path,
    ...(held instanceof LoroText && { bodyChars: held.length }),
  })
}

/**
 * The promoted record as a throwaway instance, or `null` for bytes that are
 * not a Loro snapshot. A trap is thrown, never answered as malformed: the
 * bytes may be well-formed.
 */
function readIncoming(input: PromoteWorkspaceInput): LoroDoc | null {
  const incoming = new LoroDoc()
  try {
    runEvictingOnEngineTrap(
      {
        subject: 'the promoted workspace record',
        fields: { workspaceId: input.workspaceId, updateBytes: input.snapshot.byteLength },
        // No cache holds it, so there is nothing to drop.
        evict() {},
      },
      'importing an update into',
      () => incoming.import(input.snapshot),
    )
  } catch (err) {
    if (err instanceof DocumentEngineTrapError) throw err
    return null
  }
  return incoming
}

/**
 * Promotion (ADR-0023): a browser-kept workspace record merged into a daemon
 * workspace, with the trash bytes and saved versions it points at, followed
 * by what ADR-0039 decision 8 says a person's explicit act leaves behind —
 * one explicit (`auto: false`) checkpoint per promoted document. That
 * checkpoint stays beside the carried history rather than being replaced by
 * it: the carried rows record what the browser saved, and the move is a
 * separate act by a named person. The merge is
 * `applyWorkspaceDocumentUpdate`'s and byte-identical to the sync surface's;
 * what this operation adds is the enumeration of what arrived and the rows.
 * It is merged as a TRANSFER: a promoted document keeps the `updatedAt` it
 * arrived with, because moving it is not editing it, and the explicit rows
 * below stand in for the automatic checkpoint an edit would take.
 *
 * The documents are read off the INCOMING record, not the merged one: the
 * target's own documents were not promoted and get no row for it. The rows
 * are written after the merge's lock hold, against the live projection each
 * document has once merged — a checkpoint records the state a person moved
 * the document INTO, which for a document the target already held is the
 * merge of both, exactly as the History panel will show it.
 *
 * An engine trap — on the incoming record or in the merge — is thrown as
 * `DocumentEngineTrapError`, never answered as a malformed snapshot: the
 * bytes may be well-formed, and the merge has already dropped the target's
 * poisoned record so the workspace keeps serving. A record that breaks a
 * limit or the path grammar is refused by the merge — the same judgement, and
 * the same answer, as the sync surface's — with nothing of it kept; a size
 * refusal is re-raised naming the promoted document.
 */
export async function promoteWorkspace(
  deps: Pick<ServerDeps, 'liveDocuments' | 'workspaceDocuments' | 'versions' | 'blobStore'>,
  input: PromoteWorkspaceInput,
): Promise<PromoteWorkspaceResult> {
  const incoming = readIncoming(input)
  if (incoming === null) return { kind: 'malformed-snapshot' }
  const promoted = readWorkspaceDocuments(incoming).map((entry) => entry.documentId)
  // Counted on the incoming record before any of it merges, so a record past
  // the ceiling is refused whole without the cost of judging the merge.
  if (promoted.length > WORKSPACE_MAX_DOCUMENTS) {
    return {
      kind: 'too-many-documents',
      documents: promoted.length,
      limit: WORKSPACE_MAX_DOCUMENTS,
    }
  }
  const carried = await judgeCarried(incoming, {
    trash: input.trash ?? [],
    versions: input.versions ?? [],
  })
  if (carried.kind === 'refused') return { kind: 'unmatched-carried', reason: carried.reason }
  if (carried.kind === 'too-many') {
    const { plane, carried: count, limit } = carried
    return { kind: 'too-many-carried', plane, carried: count, limit }
  }

  const applied = await applyWorkspaceDocumentUpdate(deps, {
    workspaceId: input.workspaceId,
    update: input.snapshot,
    origin: 'transfer',
  }).catch((err: unknown) => {
    throw namedInRecord(incoming, err)
  })
  if (applied.kind === 'malformed-update') return { kind: 'malformed-snapshot' }

  // The LISTING, not a by-id lookup: only the walk that sees every sibling
  // can say which document at a contested path is the shadowed one.
  const merged = await deps.workspaceDocuments.get(input.workspaceId)
  const trashStored = await storeCarriedTrash(deps.blobStore, merged, carried.trash)
  // Before the move's own checkpoints, so the history lists in the order it
  // was taken: the carried rows keep their createdAt and the move's is now.
  const versionsKept = await deps.versions.adopt(input.workspaceId, carried.versions)
  const { recorded, shadowed } = await checkpointPromoted(deps, input, merged, promoted)
  return { kind: 'promoted', recorded, shadowed, trashStored, versionsKept }
}

/**
 * One version per promoted document at the path the merge placed it; one the
 * merge shadowed at a contested path is answered as shadowed instead.
 */
async function checkpointPromoted(
  deps: Pick<ServerDeps, 'liveDocuments' | 'versions'>,
  input: PromoteWorkspaceInput,
  merged: LoroDoc,
  promoted: readonly string[],
): Promise<{ recorded: string[]; shadowed: string[] }> {
  const byId = new Map(readWorkspaceDocuments(merged).map((entry) => [entry.documentId, entry]))
  const recorded: string[] = []
  const shadowed: string[] = []
  for (const documentId of promoted) {
    const entry = byId.get(documentId)
    if (entry === undefined) continue
    if (entry.shadowed === true) {
      shadowed.push(documentId)
      continue
    }
    const doc = await deps.liveDocuments.get(input.workspaceId, entry.path)
    try {
      await deps.versions.save(input.workspaceId, entry.path, doc, {
        auto: false,
        operator: input.operator,
      })
    } catch (err) {
      // The merge has already landed, so a full history must not fail the
      // promote: the content is kept and only this document's point is
      // skipped, which `recorded` leaving it out says.
      if (err instanceof TooManyVersionsError) continue
      throw err
    }
    recorded.push(documentId)
  }
  return { recorded, shadowed }
}
