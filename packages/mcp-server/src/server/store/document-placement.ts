import type { RecordSession, WorkspaceNode } from '@kamiazya/whiteboard-loro-adapter'
import { bytesToBase64, type DocumentKind } from '@kamiazya/whiteboard-model'
import { refuseNewDocuments, refuseNewFoldersAt } from '@kamiazya/whiteboard-ports'
import type { StoreScope } from './store-scope.js'
import { evictWorkspaceDocCache } from './workspace-doc-cache.js'

const assertedAs = <T>() => ({ parse: (value: unknown) => value as T })

type Steps = Parameters<RecordSession['write']>[0]

/**
 * A path the tree does not hold is a NEW document — the per-document update's
 * lazy create among them — so it answers to the workspace's document and folder
 * ceilings like every other mint: placing it creates every folder on its path
 * the tree does not hold yet.
 */
async function refuseNewPlacementPastCeilings(record: RecordSession, path: string): Promise<void> {
  const held = await record.read({ query: 'documents' }, assertedAs<unknown[]>())
  refuseNewDocuments(held.length)
  refuseNewFoldersAt(await record.read({ query: 'nodes' }, assertedAs<WorkspaceNode[]>()), path)
}

/** The writes that put a document's node where it belongs, then its content and name. */
function placementSteps(input: {
  documentId: string
  path: string
  existingEntry: { kind: DocumentKind } | null
  requestedKind: DocumentKind | undefined
  statedKind: DocumentKind | null
  snapshot: Uint8Array
}): Steps {
  const { documentId, path, existingEntry, requestedKind } = input
  const kind = requestedKind ?? existingEntry?.kind ?? input.statedKind ?? 'spatial'
  const steps: Steps = []
  if (existingEntry === null) {
    steps.push({ op: 'createWorkspaceDocumentAtPath', args: { path, documentId, kind } })
  } else if (requestedKind !== undefined && existingEntry.kind !== requestedKind) {
    steps.push({
      op: 'updateWorkspaceDocumentMeta',
      args: { documentId, patch: { kind: requestedKind } },
    })
  }
  steps.push({
    op: 'writeDocumentContentAndName',
    args: { documentId, source: bytesToBase64(input.snapshot) },
  })
  return steps
}

/**
 * Put a document's content in the workspace tree, creating its node when the
 * path is new.
 *
 * A save that names no kind and finds none on the tree or in the content's own
 * bytes (`statedKind`) is a lazy-create of an empty document (an update route
 * hit on an unknown path); the spatial editor is what opens those, so
 * `'spatial'` is the honest default — not a guess about someone else's data.
 *
 * An EXPLICIT kind is an intentional sync request (restore reconciling a
 * different-kind source's content onto an existing target); a plain re-save
 * omits it and must never touch the value.
 *
 * Answers false when the tree gave this path to a DIFFERENT document, or no
 * longer holds the one named: with no legacy plane to fall back to, writing
 * anywhere else would fork storage silently, so the caller refuses loudly.
 */
export async function placeDocumentInTree(input: {
  record: RecordSession
  workspaceId: string
  documentId: string
  path: string
  existingEntry: { documentId: string; kind: DocumentKind } | null
  requestedKind: DocumentKind | undefined
  statedKind: DocumentKind | null
  snapshot: Uint8Array
  scope: StoreScope
}): Promise<boolean> {
  const { record, workspaceId, documentId, scope } = input
  if (input.existingEntry === null) await refuseNewPlacementPastCeilings(record, input.path)
  try {
    record.write(placementSteps(input))
    // The write is refused, with nothing said, for a document the tree no longer holds.
    const placed = await record.read(
      { query: 'workspaceDocumentEntry', args: { documentId } },
      assertedAs<unknown | null>(),
    )
    return placed !== null
  } catch (err) {
    // These write into the CACHED record as they go, so a throw part-way
    // leaves ops — a new node, the roots written so far — that the next save
    // of any document here would persist as though this one had succeeded.
    evictWorkspaceDocCache(workspaceId, scope)
    throw err
  }
}
