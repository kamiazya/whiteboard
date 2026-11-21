import {
  openStandalone,
  type RecordSession,
  type readWorkspaceDocuments,
  type StandaloneRecord,
} from '@kamiazya/whiteboard-loro-adapter'
import { WORKSPACE_MAX_DOCUMENTS } from '@kamiazya/whiteboard-model'
import { DocumentEngineTrapError, runEvictingOnEngineTrapLater } from '../document-io.js'
import type { ServerDeps } from '../server-deps.js'
import type { OperatorInfo } from '../versions/version-entry.js'
import { applyWorkspaceDocumentUpdate } from './apply-workspace-document-update.js'
import {
  type CarriedTrashBytes,
  type CarriedVersion,
  judgeCarried,
  storeCarriedTrash,
} from './promote-carried.js'
import { TextBreachRefusalError, textBreachRefusal } from './sync-write-refusals.js'

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
  /** Judging the carried versions would charge more than `limit` (`stateSize`); nothing was merged. */
  | { kind: 'carried-over-budget'; limit: number }
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

// The engine answers in the shapes the loro-adapter readers return; this
// package asserts the type and holds no schema of its own for it.
const assertedAs = <T>() => ({ parse: (value: unknown) => value as T })

type DocumentEntries = ReturnType<typeof readWorkspaceDocuments>

/**
 * A size refusal from the merge, re-raised naming the promoted document it is
 * about. The merge sees only a container and a key; the promoted record is
 * what can say which document holds it — a canvas a person can open, rather
 * than a node id they never see — and, for a body, how long it is now, which
 * for a run found only in the history tells a person the document they see is
 * not the problem.
 */
async function namedInRecord(incoming: RecordSession, err: unknown): Promise<unknown> {
  if (!(err instanceof TextBreachRefusalError)) return err
  // A runs cost is summed over the whole update, so the container holding the
  // longest run is no more its cause than any other document the update wrote.
  if (err.breach.shape === 'runs') return textBreachRefusal(err.breach)
  const place = await incoming.read(
    { query: 'containerPlace', args: { container: err.breach.container } },
    assertedAs<{ path: string; textLength?: number } | null>(),
  )
  if (place === null) return err
  return textBreachRefusal(err.breach, {
    path: place.path,
    ...(place.textLength !== undefined && { bodyChars: place.textLength }),
  })
}

/**
 * The promoted record as a throwaway engine lease, or `null` for bytes that
 * are not a Loro snapshot. A trap is thrown, never answered as malformed: the
 * bytes may be well-formed.
 */
async function readIncoming(input: PromoteWorkspaceInput): Promise<StandaloneRecord | null> {
  try {
    return await runEvictingOnEngineTrapLater(
      {
        subject: 'the promoted workspace record',
        fields: { workspaceId: input.workspaceId, updateBytes: input.snapshot.byteLength },
        // No cache holds it, so there is nothing to drop.
        evict() {},
      },
      'importing an update into',
      () => openStandalone(input.snapshot),
    )
  } catch (err) {
    if (err instanceof DocumentEngineTrapError) throw err
    return null
  }
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
  const incoming = await readIncoming(input)
  if (incoming === null) return { kind: 'malformed-snapshot' }
  try {
    return await promoteFrom(deps, input, incoming.session)
  } finally {
    incoming.release()
  }
}

async function promoteFrom(
  deps: Pick<ServerDeps, 'liveDocuments' | 'workspaceDocuments' | 'versions' | 'blobStore'>,
  input: PromoteWorkspaceInput,
  incoming: RecordSession,
): Promise<PromoteWorkspaceResult> {
  const documents = await incoming.read({ query: 'documents' }, assertedAs<DocumentEntries>())
  const promoted = documents.map((entry) => entry.documentId)
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
  if (carried.kind === 'over-budget') return { kind: 'carried-over-budget', limit: carried.limit }

  const applied = await applyWorkspaceDocumentUpdate(deps, {
    workspaceId: input.workspaceId,
    update: input.snapshot,
    origin: 'transfer',
  }).catch(async (err: unknown) => {
    throw await namedInRecord(incoming, err)
  })
  if (applied.kind === 'malformed-update') return { kind: 'malformed-snapshot' }

  // The LISTING, not a by-id lookup: only the walk that sees every sibling
  // can say which document at a contested path is the shadowed one.
  const trashStored = await deps.workspaceDocuments.withRecord(input.workspaceId, (merged) =>
    storeCarriedTrash(deps.blobStore, merged, carried.trash),
  )
  // Before the move's own checkpoints, so the history lists in the order it
  // was taken: the carried rows keep their createdAt and the move's is now.
  const versionsKept = await deps.versions.adopt(input.workspaceId, carried.versions)
  const { recorded, shadowed } = await deps.workspaceDocuments.withRecord(
    input.workspaceId,
    (merged) => checkpointPromoted(deps, input, merged, promoted),
  )
  return { kind: 'promoted', recorded, shadowed, trashStored, versionsKept }
}

/**
 * One version per promoted document at the path the merge placed it; one the
 * merge shadowed at a contested path is answered as shadowed instead.
 */
async function checkpointPromoted(
  deps: Pick<ServerDeps, 'liveDocuments' | 'versions'>,
  input: PromoteWorkspaceInput,
  merged: RecordSession,
  promoted: readonly string[],
): Promise<{ recorded: string[]; shadowed: string[] }> {
  const held = await merged.read({ query: 'documents' }, assertedAs<DocumentEntries>())
  const byId = new Map(held.map((entry) => [entry.documentId, entry]))
  const shadowed: string[] = []
  const owned: { documentId: string; path: string }[] = []
  for (const documentId of promoted) {
    const entry = byId.get(documentId)
    if (entry === undefined) continue
    if (entry.shadowed === true) {
      shadowed.push(documentId)
      continue
    }
    owned.push({ documentId, path: entry.path })
  }
  // The merge has already landed, so a full history must not fail the promote:
  // the content is kept and only that document's point is skipped, which the
  // answer leaving it out says.
  const recorded = [
    ...(await deps.versions.saveAll(input.workspaceId, owned, {
      auto: false,
      operator: input.operator,
    })),
  ]
  return { recorded, shadowed }
}
