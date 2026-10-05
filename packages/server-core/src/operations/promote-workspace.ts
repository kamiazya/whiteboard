import { readWorkspaceDocuments } from '@kamiazya/whiteboard-loro-adapter'
import { documentPathSchema } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { DocumentEngineTrapError, runEvictingOnEngineTrap } from '../document-io.js'
import type { ServerDeps } from '../server-deps.js'
import type { Attestation, OperatorInfo } from '../versions/version-entry.js'
import { applyWorkspaceDocumentUpdate } from './apply-workspace-document-update.js'

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
  /**
   * The record holds documents at paths outside the document-path grammar,
   * which this keeper's readers refuse; nothing was merged.
   */
  | { kind: 'invalid-paths'; paths: readonly string[] }
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
 * The paths in a promoted record that the document-path grammar refuses.
 * The record is refused whole rather than merged around them: a document at
 * such a path, once in the target's record, fails every listing and search of
 * the workspace, and a merge cannot be taken back.
 */
function offGrammarPaths(entries: readonly { readonly path: string }[]): string[] {
  return entries
    .map((entry) => entry.path)
    .filter((path) => !documentPathSchema.safeParse(path).success)
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
 * poisoned record so the workspace keeps serving. A record that would leave a
 * body past the markdown size limit is `MarkdownBodyTooLargeError`, thrown by
 * the merge with nothing of it kept.
 */
export async function promoteWorkspace(
  deps: Pick<ServerDeps, 'liveDocuments' | 'workspaceDocuments' | 'versions'>,
  input: PromoteWorkspaceInput,
): Promise<PromoteWorkspaceResult> {
  const incoming = readIncoming(input)
  if (incoming === null) return { kind: 'malformed-snapshot' }
  const incomingEntries = readWorkspaceDocuments(incoming)
  const invalidPaths = offGrammarPaths(incomingEntries)
  if (invalidPaths.length > 0) return { kind: 'invalid-paths', paths: invalidPaths }
  const promoted = incomingEntries.map((entry) => entry.documentId)

  const applied = await applyWorkspaceDocumentUpdate(deps, {
    workspaceId: input.workspaceId,
    update: input.snapshot,
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
