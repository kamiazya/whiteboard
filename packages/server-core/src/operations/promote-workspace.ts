import { readWorkspaceDocuments, WORKSPACE_TREE_KEY } from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc, type LoroText, type TreeID } from 'loro-crdt'
import { DocumentEngineTrapError, runEvictingOnEngineTrap } from '../document-io.js'
import type { ServerDeps } from '../server-deps.js'
import type { Attestation, OperatorInfo } from '../versions/version-entry.js'
import { applyWorkspaceDocumentUpdate } from './apply-workspace-document-update.js'
import { MarkdownBodyTooLargeError } from './sync-write-refusals.js'

export interface PromoteWorkspaceInput {
  readonly workspaceId: string
  /** The browser keeper's whole record, as a Loro snapshot. */
  readonly snapshot: Uint8Array
  /** The person who promoted, as the route states them (ADR-0039 decision 8). */
  readonly operator: OperatorInfo
  /** Their evidence, when the route asked for and verified one. */
  readonly attestation?: Attestation
}

export type PromoteWorkspaceResult =
  | { kind: 'malformed-snapshot' }
  | {
      kind: 'promoted'
      /** The documents the record carried, each now with an explicit checkpoint. */
      recorded: readonly string[]
      /**
       * Documents that arrived shadowed — the target already held another
       * document at their path. No checkpoint is written for them: a
       * version row is addressed by PATH and would name the document that
       * won the address, which is not the one that was promoted.
       */
      shadowed: readonly string[]
    }

/**
 * A size refusal from the merge, re-raised naming the promoted document it is
 * about. The merge sees only a text container; the promoted record is what
 * can say whose body it is, and how long that body is now — which, for a run
 * found only in the history, is what tells a person the document they see is
 * not the problem.
 */
function namedInRecord(incoming: LoroDoc, err: unknown): unknown {
  if (!(err instanceof MarkdownBodyTooLargeError) || err.container === undefined) return err
  const path = incoming.getPathToContainer(err.container)
  if (path?.length !== 3 || path[0] !== WORKSPACE_TREE_KEY) return err
  const node = incoming.getTree(WORKSPACE_TREE_KEY).getNodeByID(path[1] as TreeID)
  const documentId = node?.data.get('documentId')
  const entry = readWorkspaceDocuments(incoming).find((each) => each.documentId === documentId)
  if (entry === undefined) return err
  const body = incoming.getContainerById(err.container) as LoroText
  return new MarkdownBodyTooLargeError(err.shape, err.chars, err.container, {
    path: entry.path,
    chars: body.length,
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
 * workspace, followed by what ADR-0039 decision 8 says a person's explicit
 * act leaves behind — one explicit (`auto: false`) checkpoint per promoted
 * document, carrying the attestation when there is one. The merge is
 * `applyWorkspaceDocumentUpdate`'s and byte-identical to the sync surface's;
 * what this operation adds is the enumeration of what arrived and the rows.
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
  deps: Pick<ServerDeps, 'liveDocuments' | 'workspaceDocuments' | 'versions'>,
  input: PromoteWorkspaceInput,
): Promise<PromoteWorkspaceResult> {
  const incoming = readIncoming(input)
  if (incoming === null) return { kind: 'malformed-snapshot' }
  const promoted = readWorkspaceDocuments(incoming).map((entry) => entry.documentId)

  const applied = await applyWorkspaceDocumentUpdate(deps, {
    workspaceId: input.workspaceId,
    update: input.snapshot,
  }).catch((err: unknown) => {
    throw namedInRecord(incoming, err)
  })
  if (applied === 'malformed-update') return { kind: 'malformed-snapshot' }

  // The LISTING, not a by-id lookup: only the walk that sees every sibling
  // can say which document at a contested path is the shadowed one.
  const merged = await deps.workspaceDocuments.get(input.workspaceId)
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
    await deps.versions.save(input.workspaceId, entry.path, doc, {
      auto: false,
      operator: input.operator,
      ...(input.attestation === undefined ? {} : { attestation: input.attestation }),
    })
    recorded.push(documentId)
  }
  return { kind: 'promoted', recorded, shadowed }
}
