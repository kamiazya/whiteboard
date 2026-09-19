import { readWorkspaceDocuments } from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
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
 */
export async function promoteWorkspace(
  deps: Pick<ServerDeps, 'liveDocuments' | 'workspaceDocuments' | 'versions'>,
  input: PromoteWorkspaceInput,
): Promise<PromoteWorkspaceResult> {
  const incoming = new LoroDoc()
  try {
    incoming.import(input.snapshot)
  } catch {
    return { kind: 'malformed-snapshot' }
  }
  const promoted = readWorkspaceDocuments(incoming).map((entry) => entry.documentId)

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
