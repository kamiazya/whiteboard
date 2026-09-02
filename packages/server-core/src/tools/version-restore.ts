import { documentIdSchema, documentPathSchema, workspaceIdSchema } from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import { restoreVersion } from '../operations/restore-version.js'
import type { ServerDeps } from '../server-deps.js'
import { resolveDocumentInWorkspace } from './assert-document-in-workspace.js'

export const versionRestoreInputSchema = z
  .object({
    workspaceId: workspaceIdSchema.describe('Workspace ID the document belongs to.'),
    documentId: documentIdSchema.describe(
      'Document ID (ULID) whose history holds the version. Restored onto itself unless targetPath is given.',
    ),
    versionId: z
      .string()
      .min(1)
      .describe('Version id (`version.id`) returned by wb_version_save or wb_version_list.'),
    targetPath: documentPathSchema
      .optional()
      .describe(
        'Restore into this path instead of in place: a path not yet taken becomes a new document holding the saved state; an existing one needs overwrite: true and is reconciled in place.',
      ),
    overwrite: z
      .boolean()
      .optional()
      .describe('Required to restore onto a targetPath that already holds a document.'),
    subtree: z
      .boolean()
      .optional()
      .describe(
        'Roll the document AND every descendant back to this version — needs a version saved with the whole workspace (every version this history records is). Not combinable with targetPath.',
      ),
  })
  .strict()
export type VersionRestoreInput = z.infer<typeof versionRestoreInputSchema>

export const versionRestoreOutputSchema = z
  .object({
    documentId: documentIdSchema,
    restoredVersionId: z.string(),
    label: z.string().optional(),
    mode: z.enum(['in-place', 'into-target', 'subtree']),
    /** `into-target` only: where the saved state landed. */
    targetPath: z.string().optional(),
    /** `into-target` only: nodes alive in the restored content, an advisory count for confirmation copy. */
    elementCount: z.number().int().min(0).optional(),
    /** `subtree` only: documents the rollback touched. */
    restoredCount: z.number().int().min(0).optional(),
  })
  .strict()
export type VersionRestoreOutput = z.infer<typeof versionRestoreOutputSchema>

export class VersionNotFoundError extends Error {
  constructor(
    public readonly documentId: string,
    public readonly versionId: string,
  ) {
    super(`version not found: ${versionId} in document ${documentId}`)
    this.name = 'VersionNotFoundError'
  }
}

/** The targetPath already holds a document and the caller did not pass `overwrite`. */
export class RestoreTargetExistsError extends Error {
  constructor(public readonly targetPath: string) {
    super(`target already exists: ${targetPath} — pass overwrite: true to restore onto it`)
    this.name = 'RestoreTargetExistsError'
  }
}

/** A subtree rollback needs the whole workspace at that point, and this version does not carry it. */
export class SubtreeNeedsWorkspaceVersionError extends Error {
  constructor(public readonly versionId: string) {
    super(`subtree rollback needs a workspace-scoped version: ${versionId}`)
    this.name = 'SubtreeNeedsWorkspaceVersionError'
  }
}

/** A subtree rollback was asked to land somewhere other than where it rolls back. */
export class SubtreeTakesNoTargetError extends Error {
  constructor() {
    super('subtree rollback cannot take a targetPath')
    this.name = 'SubtreeTakesNoTargetError'
  }
}

/**
 * The MCP surface of `restoreVersion` — all three of its modes, the same
 * operation the History panel's Restore button reaches over HTTP, so an
 * agent rolling back and a person rolling back get one answer. A watching
 * browser is told through the notifier the way it is told by the route.
 *
 * The operation answers with a result union; this surface maps each refusal
 * onto a typed error because an MCP caller reads a refusal from the error
 * text, and a success onto one flat record because a flat record is what an
 * agent can read without a second lookup.
 */
export function createVersionRestoreTool(deps: ServerDeps) {
  return {
    name: 'wb_version_restore' as const,
    description:
      'Restore a document to one of its saved versions — in place by default, into another path with targetPath, or the document and every descendant with subtree. Nothing rewinds: the restore is a new edit whose result equals the saved state.',
    inputSchema: versionRestoreInputSchema,
    outputSchema: versionRestoreOutputSchema,
    execute: async (input: VersionRestoreInput): Promise<VersionRestoreOutput> => {
      const { workspaceId, documentId, versionId, targetPath, overwrite, subtree } =
        versionRestoreInputSchema.parse(input)
      const entry = await resolveDocumentInWorkspace(deps.documentIndex, workspaceId, documentId)
      // Read from the source's own history, which is where the id has to
      // live for the operation to accept it: a restore into a brand-new
      // target has no watching client and emits no progress, so the label
      // cannot be picked up from the `started` event there.
      const label = (await deps.versions.list(workspaceId, entry.path)).find(
        (v) => v.id === versionId,
      )?.label
      const result = await restoreVersion(
        deps,
        {
          workspaceId,
          path: entry.path,
          versionId,
          ...(targetPath === undefined ? {} : { targetPath }),
          ...(overwrite === undefined ? {} : { overwrite }),
          ...(subtree === undefined ? {} : { subtree }),
        },
        (event) => deps.clientNotifier?.restoreProgress(event),
      )
      const base = {
        documentId,
        restoredVersionId: versionId,
        ...(label === undefined ? {} : { label }),
      }
      switch (result.kind) {
        case 'restored-in-place':
          return { ...base, mode: 'in-place' }
        case 'restored-to-target':
          return {
            ...base,
            mode: 'into-target',
            targetPath: result.targetPath,
            elementCount: result.elementCount,
          }
        case 'restored-subtree':
          return { ...base, mode: 'subtree', restoredCount: result.restoredCount }
        case 'not-found':
          throw new VersionNotFoundError(documentId, versionId)
        case 'output-exists':
          throw new RestoreTargetExistsError(result.targetPath)
        case 'subtree-needs-workspace-version':
          throw new SubtreeNeedsWorkspaceVersionError(versionId)
        case 'subtree-takes-no-target':
          throw new SubtreeTakesNoTargetError()
        case 'invalid-target-path':
          // Unreachable through this surface: the input schema validated the
          // path before the operation saw it. Kept as a refusal rather than
          // an assertion so a schema that loosens later still refuses.
          throw new Error(`invalid targetPath: ${targetPath}`)
      }
    },
  }
}
