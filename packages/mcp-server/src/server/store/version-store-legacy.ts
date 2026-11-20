import { frontiersFromBase64, frontiersToBase64 } from '@kamiazya/whiteboard-history'
import { projectWorkspaceDocument } from '@kamiazya/whiteboard-loro-adapter'
import { messageOf } from '@kamiazya/whiteboard-model'
import { decodeFrontiers, encodeFrontiers, type Frontiers, type LoroDoc } from 'loro-crdt'
import { validateVersionId, validateWorkspaceId } from '../validators.js'
import { corruptStoredData } from './corrupt-stored-data.js'
import { globalStoreScope, type StoreScope } from './store-scope.js'
import { openWorkspaceDocIfStored } from './workspace-doc-cache.js'

// What the version store still answers as a `LoroDoc`: the past state of a
// document or of the whole workspace, which `VersionHistory.load` and
// `loadWorkspaceAt` hand to operations that read the past through one, and the
// frontiers an adopted row carries as a `Frontiers`.
//
// ponytail: in one file so the version store itself holds its record only
// through a session. The seam changes to bytes and a view the caller releases
// when restore-version and promote-carried move, and this file goes then.

/** A frontier as the text a version row stores: the engine's bytes, base64. */
export function frontiersToText(frontiers: Frontiers): string {
  return frontiersToBase64(encodeFrontiers(frontiers))
}

/** Throws on text that is not a stored frontier. */
function frontiersFromText(text: string): Frontiers {
  return decodeFrontiers(frontiersFromBase64(text))
}

/** Moves `doc` to a saved version's point; frontiers it cannot reach are corruption. */
function checkoutVersion(doc: LoroDoc, versionId: string, frontiers: string): void {
  try {
    doc.checkout(frontiersFromText(frontiers))
  } catch (error) {
    throw corruptStoredData(
      `versions/${versionId}`,
      `frontiers could not be checked out against the workspace document (${messageOf(error)})`,
    )
  }
}

/** See `VersionStore.openCheckouts`. */
export interface VersionCheckouts {
  /** What `VersionStore.load` answers, read off the shared copy. */
  load(versionId: string): Promise<LoroDoc | null>
}

/** The rows a checkout reads: a version's frontiers and the document it names. */
export interface CheckoutRows {
  version(id: string): Promise<{ frontiers: string; documentId: string } | undefined>
}

export async function openVersionCheckouts(
  workspaceId: string,
  rows: CheckoutRows,
  scope: StoreScope = globalStoreScope,
): Promise<VersionCheckouts> {
  validateWorkspaceId(workspaceId)
  // Forked on the first version that needs it, so a walk over a document
  // with no versions copies nothing.
  let copy: LoroDoc | null = null
  let standsAt: string | null = null
  return {
    load: async (id) => {
      validateVersionId(id)
      const row = await rows.version(id)
      if (!row) return null
      // Checked out against the WORKSPACE record, whose oplog the frontiers
      // were recorded in — never against a live per-document projection,
      // whose fresh lineage does not contain them. The past state is then
      // projected back out as a standalone doc, which is the shape every
      // caller expects; the projection copies, so the next checkout of the
      // shared copy cannot reach it.
      if (copy === null) {
        const record = await openWorkspaceDocIfStored(workspaceId, scope)
        if (record === null) {
          throw corruptStoredData(
            `versions/${id}`,
            'workspace-scoped version has no stored workspace document to check out against',
          )
        }
        copy = record.fork()
      }
      if (standsAt !== row.frontiers) {
        checkoutVersion(copy, id, row.frontiers)
        standsAt = row.frontiers
      }
      return projectWorkspaceDocument(copy, row.documentId)
    },
  }
}

/** The whole workspace as it stood at a version, or `null` when the record is gone. */
export async function loadWorkspaceVersionAt(
  workspaceId: string,
  id: string,
  frontiers: string,
  scope: StoreScope = globalStoreScope,
): Promise<LoroDoc | null> {
  const record = await openWorkspaceDocIfStored(workspaceId, scope)
  if (record === null) return null
  const clone = record.fork()
  checkoutVersion(clone, id, frontiers)
  return clone
}
