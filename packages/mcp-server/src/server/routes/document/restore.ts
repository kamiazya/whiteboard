import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { Hono } from 'hono'
import type { LoroDoc } from 'loro-crdt'
import { restoreVersionRequestSchema } from '../../../shared/api-contracts/document.js'
import { countAliveNodes } from '../../store/count-alive-nodes.js'
import { evictDoc, getDoc } from '../../store/doc-cache.js'
import {
  ConflictError,
  documentExists,
  getDocumentKind,
  saveDocument,
} from '../../store/document-store.js'
import type { VersionStore } from '../../store/version-store.js'
import { withWorkspaceWriteLock } from '../../store/workspace-lock.js'
import { validateDocumentPath, validateVersionId, validationErrorBody } from '../../validators.js'
import { getBroadcastFn, handleCorruptStoredData } from './_shared.js'
import { onDocumentsRoute } from './path-route.js'

export interface RestoreRouterOptions {
  versionStore: VersionStore
}

// Reconciles `past` onto `doc` (the LIVE cached doc for workspaceId/targetPath),
// commits, persists, and broadcasts the resulting update. Shared by both the
// in-place restore and the overwrite-an-existing-canvas restore, because both
// must mutate the same document instance any connected client already holds:
// a delta broadcast only means something against the doc it was diffed from,
// so "overwrite" cannot be a file swap without breaking every connected peer.
async function reconcileCommitSaveBroadcast(
  workspaceId: string,
  targetPath: string,
  doc: LoroDoc,
  past: LoroDoc,
  label: string | undefined,
  kind: DocumentKind | null = null,
): Promise<void> {
  const { sendRestoreEvent } = await import('../ws.js')
  sendRestoreEvent(workspaceId, targetPath, 'started', label)
  try {
    const prevVV = doc.version()
    try {
      doc.import(past.export({ mode: 'snapshot' }))
      doc.commit()
      await saveDocument(workspaceId, targetPath, doc, {
        overwrite: true,
        ...(kind !== null ? { kind } : {}),
      })
    } catch (err) {
      // doc.import mutates the cached doc in place before commit/save
      // run, so any failure in this block leaves the cache ahead of
      // durable state. Evict it so the next read reloads the last
      // successfully persisted snapshot.
      evictDoc(workspaceId, targetPath)
      throw err
    }
    const update = doc.export({ mode: 'update', from: prevVV }) as Uint8Array
    if (update.byteLength > 0) {
      getBroadcastFn()(workspaceId, targetPath, update)
    }
  } finally {
    // Always send complete, even on error, or the client overlay can stay locked forever.
    sendRestoreEvent(workspaceId, targetPath, 'complete')
  }
}

// POST /api/workspaces/:workspaceId/documents/:path/versions/:id/restore
//
// Two modes share this endpoint:
//
//   1. In-place reconcile (default; History panel uses this).
//      CRDTs cannot forget history, so restore commits new ops that
//      represent the past state:
//        only in past    -> insert into current, or un-tombstone + restore fields
//        only in current -> set isDeleted=true (tombstone)
//        in both         -> copy differing fields from past onto current
//
//   2. Restore into `targetPath` — body `{ targetPath, overwrite? }`.
//      If `targetPath` does not yet exist, this writes the past doc as a
//      brand-new canvas; the source canvas is untouched. If `targetPath`
//      already exists, `overwrite: true` is required, and the restore goes
//      through the SAME reconcile-onto-the-live-doc path as mode 1, applied
//      to the target's live doc instead of the source's — never a straight
//      file replacement. `targetPath === path` collapses into mode 1.
//      Without `overwrite`, an existing target returns 409 `output_exists`.
//      Replaces the deleted `checkpoint_restore` flow.
export function createRestoreRouter(options: RestoreRouterOptions) {
  const app = new Hono()
  const { versionStore } = options

  onDocumentsRoute(
    app,
    'post',
    ['versions', ':id', 'restore'],
    async (c, workspaceId, path, params) => {
      const id = params.id as string
      try {
        validateVersionId(id)
      } catch (err) {
        const body = validationErrorBody(err)
        if (body) return c.json(body, 400)
        throw err
      }
      // Body is optional. Empty body / non-JSON ⇒ in-place mode.
      const rawText = await c.req.text()
      let targetPath: string | undefined
      let overwrite = false
      if (rawText.length > 0) {
        let parsedJson: unknown
        try {
          parsedJson = JSON.parse(rawText)
        } catch {
          return c.json({ error: 'invalid_body', message: 'malformed JSON' }, 400)
        }
        const parsed = restoreVersionRequestSchema.safeParse(parsedJson)
        if (!parsed.success) {
          return c.json({ error: 'invalid_body', message: 'invalid restore options' }, 400)
        }
        targetPath = parsed.data.targetPath
        overwrite = parsed.data.overwrite === true
      }
      try {
        // Every doc read + save below runs inside one workspace-lock hold.
        // getDoc() alone is unlocked, so a concurrent delete/rename that runs
        // its whole lock-protected section between an unlocked read here and
        // the eventual saveDocument() would find no row left at that path and
        // silently insert a brand-new phantom canvas (or resurrect content
        // onto a path the delete just cleared). Both the in-place branch and
        // the targetPath-overwrite branch have that getDoc(path)->saveDocument(path)
        // shape, so one lock around the whole handler body closes it for both
        // — mirrors live-doc.ts's POST /update handler.
        return await withWorkspaceWriteLock(workspaceId, async () => {
          const doc = await getDoc(workspaceId, path)
          const past = await versionStore.load(workspaceId, id, doc)
          if (!past) {
            return c.json({ error: 'not_found' }, 404)
          }

          // Restore-as-new-canvas / overwrite-existing-canvas branch.
          // targetPath === path is the same document as the in-place restore
          // below, so route it there directly instead of forcing callers to
          // pass overwrite:true against their own canvas.
          if (targetPath !== undefined && targetPath !== path) {
            try {
              validateDocumentPath(targetPath)
            } catch (err) {
              const body = validationErrorBody(err)
              if (body) return c.json(body, 400)
              throw err
            }

            const targetAlreadyExists = await documentExists(workspaceId, targetPath)
            if (targetAlreadyExists && !overwrite) {
              return c.json(
                {
                  error: 'output_exists',
                  message: `Target canvas "${targetPath}" already exists. Pass overwrite=true to replace it.`,
                },
                409,
              )
            }

            if (targetAlreadyExists) {
              // The version id belongs to the SOURCE canvas's history, so its
              // label lives in the source's version list even though we are
              // about to reconcile it onto the target.
              const all = await versionStore.list(workspaceId, path)
              const label = all.find((v) => v.id === id)?.label
              const targetDoc = await getDoc(workspaceId, targetPath)
              // The merged content is the source's own shape (spatial nodes/edges
              // vs. a markdown body), same reasoning as the new-canvas branch
              // below — the target's stored kind must follow it or a kind-aware
              // consumer (editor routing) opens the overwritten canvas with the
              // wrong editor.
              const sourceKind = await getDocumentKind(workspaceId, path)
              await reconcileCommitSaveBroadcast(
                workspaceId,
                targetPath,
                targetDoc,
                past,
                label,
                sourceKind,
              )
              return c.json({
                documentId: `${workspaceId}/${targetPath}`,
                elementCount: countAliveNodes(targetDoc),
              })
            }

            // Genuinely new canvas: no live doc and no connected clients, so
            // there is nothing to reconcile against. The restored content is
            // whatever the source canvas actually stores (spatial nodes/edges
            // maps vs. a markdown 'body' text container), so the new row must
            // carry the source's own kind rather than falling back to the
            // saveDocument default.
            try {
              const sourceKind = await getDocumentKind(workspaceId, path)
              await saveDocument(workspaceId, targetPath, past, {
                overwrite: false,
                ...(sourceKind !== null ? { kind: sourceKind } : {}),
              })
            } catch (err) {
              if (err instanceof ConflictError) {
                return c.json(
                  {
                    error: 'output_exists',
                    message: `Target canvas "${targetPath}" already exists. Pass overwrite=true to replace it.`,
                  },
                  409,
                )
              }
              throw err
            }
            // Guard against a stale cache entry from a since-deleted canvas at
            // this path being served instead of the just-written snapshot.
            evictDoc(workspaceId, targetPath)
            return c.json({
              documentId: `${workspaceId}/${targetPath}`,
              elementCount: countAliveNodes(past),
            })
          }

          // In-place reconcile branch (default).
          const all = await versionStore.list(workspaceId, path)
          const label = all.find((v) => v.id === id)?.label
          await reconcileCommitSaveBroadcast(workspaceId, path, doc, past, label)
          return c.json({ ok: true })
        })
      } catch (err) {
        const issue = handleCorruptStoredData(err)
        if (issue) return c.json(issue.body, issue.status)
        throw err
      }
    },
  )

  return app
}
