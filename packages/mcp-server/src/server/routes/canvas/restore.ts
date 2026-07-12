import { Hono } from 'hono'
import type { LoroDoc } from 'loro-crdt'
import { restoreVersionRequestSchema } from '../../../shared/api-contracts/canvas.js'
import { reconcileElementsOnDoc } from '../../../shared/reconcile-elements.js'
import { canvasExists, ConflictError, saveCanvas } from '../../store/canvas-store.js'
import { evictDoc, getDoc } from '../../store/doc-cache.js'
import type { VersionStore } from '../../store/version-store.js'
import {
  validateSlug,
  validateVersionId,
  validateWorkspaceId,
  validationErrorBody,
} from '../../validators.js'
import { getBroadcastFn, handleCorruptStoredData } from './shared.js'

export interface RestoreRouterOptions {
  versionStore: VersionStore
}

function countElements(doc: LoroDoc): number {
  try {
    const list = doc.getMovableList('elements').toJSON() as Array<{ isDeleted?: boolean }>
    return list.filter((el) => el.isDeleted !== true).length
  } catch {
    return 0
  }
}

// Reconciles `past` onto `doc` (the LIVE cached doc for workspaceId/targetSlug),
// commits, persists, and broadcasts the resulting update. Shared by both the
// in-place restore and the overwrite-an-existing-canvas restore, because both
// must mutate the same document instance any connected client already holds:
// a delta broadcast only means something against the doc it was diffed from,
// so "overwrite" cannot be a file swap without breaking every connected peer.
async function reconcileCommitSaveBroadcast(
  workspaceId: string,
  targetSlug: string,
  doc: LoroDoc,
  past: LoroDoc,
  label: string | undefined,
): Promise<void> {
  const { sendRestoreEvent } = await import('../ws.js')
  sendRestoreEvent(workspaceId, targetSlug, 'started', label)
  try {
    const prevVV = doc.version()
    reconcileElementsOnDoc(doc, past)
    doc.commit()
    try {
      await saveCanvas(workspaceId, targetSlug, doc, { overwrite: true })
    } catch (err) {
      // reconcileElementsOnDoc + commit above already mutated the cached
      // doc, so a failed save would otherwise leave the cache ahead of
      // durable state. Evict it so the next read reloads the last
      // successfully persisted snapshot.
      evictDoc(workspaceId, targetSlug)
      throw err
    }
    const update = doc.export({ mode: 'update', from: prevVV }) as Uint8Array
    if (update.byteLength > 0) {
      getBroadcastFn()(workspaceId, targetSlug, update)
    }
  } finally {
    // Always send complete, even on error, or the client overlay can stay locked forever.
    sendRestoreEvent(workspaceId, targetSlug, 'complete')
  }
}

// POST /api/workspaces/:workspaceId/canvases/:slug/versions/:id/restore
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
//   2. Restore into `targetSlug` — body `{ targetSlug, overwrite? }`.
//      If `targetSlug` does not yet exist, this writes the past doc as a
//      brand-new canvas; the source canvas is untouched. If `targetSlug`
//      already exists, `overwrite: true` is required, and the restore goes
//      through the SAME reconcile-onto-the-live-doc path as mode 1, applied
//      to the target's live doc instead of the source's — never a straight
//      file replacement. `targetSlug === slug` collapses into mode 1.
//      Without `overwrite`, an existing target returns 409 `output_exists`.
//      Replaces the deleted `checkpoint_restore` flow.
export function createRestoreRouter(options: RestoreRouterOptions) {
  const app = new Hono()
  const { versionStore } = options

  app.post('/api/workspaces/:workspaceId/canvases/:slug/versions/:id/restore', async (c) => {
    const { workspaceId, slug, id } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
      validateSlug(slug)
      validateVersionId(id)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    // Body is optional. Empty body / non-JSON ⇒ in-place mode.
    const rawText = await c.req.text()
    let targetSlug: string | undefined
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
      targetSlug = parsed.data.targetSlug
      overwrite = parsed.data.overwrite === true
    }
    try {
      const doc = await getDoc(workspaceId, slug)
      const past = await versionStore.load(workspaceId, id, doc)
      if (!past) {
        return c.json({ error: 'not_found' }, 404)
      }

      // Restore-as-new-canvas / overwrite-existing-canvas branch.
      if (targetSlug !== undefined) {
        try {
          validateSlug(targetSlug)
        } catch (err) {
          const body = validationErrorBody(err)
          if (body) return c.json(body, 400)
          throw err
        }

        const targetAlreadyExists = await canvasExists(workspaceId, targetSlug)
        if (targetAlreadyExists && !overwrite) {
          return c.json(
            {
              error: 'output_exists',
              message: `Target canvas "${targetSlug}" already exists. Pass overwrite=true to replace it.`,
            },
            409,
          )
        }

        if (targetAlreadyExists) {
          // The version id belongs to the SOURCE canvas's history, so its
          // label lives in the source's version list even though we are
          // about to reconcile it onto the target.
          const all = await versionStore.list(workspaceId, slug)
          const label = all.find((v) => v.id === id)?.label
          const targetDoc = await getDoc(workspaceId, targetSlug)
          await reconcileCommitSaveBroadcast(workspaceId, targetSlug, targetDoc, past, label)
          return c.json({
            canvasId: `${workspaceId}/${targetSlug}`,
            elementCount: countElements(targetDoc),
          })
        }

        // Genuinely new canvas: no live doc and no connected clients, so
        // there is nothing to reconcile against.
        try {
          await saveCanvas(workspaceId, targetSlug, past, { overwrite: false })
        } catch (err) {
          if (err instanceof ConflictError) {
            return c.json(
              {
                error: 'output_exists',
                message: `Target canvas "${targetSlug}" already exists. Pass overwrite=true to replace it.`,
              },
              409,
            )
          }
          throw err
        }
        // Guard against a stale cache entry from a since-deleted canvas at
        // this slug being served instead of the just-written snapshot.
        evictDoc(workspaceId, targetSlug)
        return c.json({
          canvasId: `${workspaceId}/${targetSlug}`,
          elementCount: countElements(past),
        })
      }

      // In-place reconcile branch (default).
      const all = await versionStore.list(workspaceId, slug)
      const label = all.find((v) => v.id === id)?.label
      await reconcileCommitSaveBroadcast(workspaceId, slug, doc, past, label)
      return c.json({ ok: true })
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  return app
}
