import { movesForPathChange } from '@kamiazya/whiteboard-codec'
import {
  type CreateDocumentResponse,
  createDocumentRequestSchema,
  createWorkspaceRequestSchema,
  type DeleteDocumentResponse,
  type ListDocumentsResponse,
  type ListWorkspacesResponse,
  type RenameDocumentPathResponse,
  renameDocumentPathRequestSchema,
  renameWorkspaceRequestSchema,
  type WorkspaceSummary,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import type { ReplicaTier } from '@kamiazya/whiteboard-daemon-client/api-contracts/replica-key'
import {
  deriveWorkspaceSegment,
  generateDocumentId,
  workspaceSegmentSchema,
} from '@kamiazya/whiteboard-model'
import { type DocumentIndex, isWorkspaceNotFoundError } from '@kamiazya/whiteboard-ports'
import type { ApiErrorBody } from '@kamiazya/whiteboard-server-core'
import {
  followReferencesAfterRename,
  type ServerDeps,
  wbDocumentCreate,
  wbDocumentDelete,
  wbDocumentList,
} from '@kamiazya/whiteboard-server-core'
import { Hono } from 'hono'
import type { z } from 'zod'
import { getDefaultServerDeps } from '../../../di/default-server-deps.js'
import { getLogger } from '../../log.js'
import { validateDocumentPath, validateWorkspaceId } from '../../validators.js'
import { workspaceIdFromHandle } from '../../workspace-handle.js'
import type { WorkspaceAdmit } from '../auth.js'
import {
  corruptStored,
  firstOwned,
  hasDescendants,
  jsonBody,
  moveIntoSelf,
  notFoundAs,
  pathTakenAs,
  refusedBy,
  segmentTaken,
  segmentUnusable,
  workspaceNotFoundAs,
} from './_shared.js'
import { onDocumentsRoute } from './path-route.js'

// Names the specific field createDocumentRequestSchema rejected, instead of a
// single message covering the whole request — a valid path with an invalid
// kind must not be told "path is required", which names the wrong field and
// gives the caller no path to recovery.
function createDocumentRequestErrorTitle(error: z.ZodError): string {
  const issue = error.issues[0]
  const field = issue?.path[0]
  if (field === 'kind') return 'kind must be "spatial" or "markdown"'
  if (field === 'path') return 'path is required'
  return issue?.message ?? 'invalid request body'
}

/**
 * The first segment nobody holds, starting from the candidate a display name
 * derived. Reads the registry rather than counting from a stored number:
 * what makes a segment unavailable is another row holding it, and asking is
 * the only thing that stays true after a delete or a rename.
 *
 * Advisory, not authoritative — two creates can both find the same candidate
 * free. The registry's unique index is what actually decides, and the caller
 * translates its refusal.
 */
async function firstFreeSegment(index: DocumentIndex, base: string): Promise<string | undefined> {
  const taken = new Set((await index.listWorkspaces()).map((w) => w.segment))
  if (!taken.has(base)) return base
  // Starts at 2 because the unsuffixed segment IS the first one. A `-1` would
  // read as the first of a series whose first member is spelled differently.
  //
  // Bounded, and each candidate re-validated — both mirrored from the
  // browser's `createBrowserWorkspace`, which is the same decision one keeper
  // over: a suffix can push a long base out of the segment charset, and a
  // segment nothing validated is one the address layer refuses later,
  // somewhere less obvious. Past the bound the workspace is addressed by its
  // canonical id, which is what that layer is for.
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`
    if (!workspaceSegmentSchema.safeParse(candidate).success) return undefined
    if (!taken.has(candidate)) return candidate
  }
  return undefined
}

/**
 * How many documents one workspace holds, for the listing.
 *
 * A registry row can exist with no workspace TREE behind it — `listWorkspaces`
 * returns it and `listDocuments` throws `WorkspaceNotFoundError` for it. That
 * is a real state on a live daemon, and counting every row without allowing
 * for it turned ONE such workspace into a 500 for the whole list: a listing
 * that worked before the count was added stopped working at all.
 *
 * Zero, not absent: the row is a workspace, and it holds nothing. Absent means
 * "this keeper does not count", which is a different statement and belongs to
 * the browser, not to a daemon workspace that simply has no tree yet.
 *
 * Caught per ROW rather than around the whole listing, so one workspace's
 * missing tree costs the others nothing.
 */
async function countDocuments(index: DocumentIndex, workspaceId: string): Promise<number> {
  try {
    return (await index.listDocuments({ workspaceId })).length
  } catch (err) {
    if (isWorkspaceNotFoundError(err)) return 0
    throw err
  }
}

export interface WorkspacesRouterOptions {
  /** The operations this router adapts onto. Omitted by callers that have
   *  not been given a container — see `getDefaultServerDeps`, which is the
   *  same wiring production passes in, not a stand-in for it. */
  serverDeps?: ServerDeps
  /** Resolves the read plane's effective tier per workspace (ADR-0042
   *  decisions 1/3/5). Absent means the listing omits `tier` — app.ts wires
   *  this from `options.replicaKeys?.effectiveTier` only when a replica-key
   *  store was supplied. */
  replicaTier?: (workspaceId: string) => Promise<ReplicaTier>
  /** S8 slice 2: the membership gate GET /api/workspaces filters the listing
   *  through, rather than refusing the whole request — a name is a leak to a
   *  non-member the way its content is. Absent means no filtering (server-
   *  mode, and any composition that has not wired members). */
  admit?: WorkspaceAdmit
}

// GET /api/workspaces
// GET /api/workspaces/:workspaceId/documents
// POST /api/workspaces/:workspaceId/documents  body: { path: string }
/**
 * Rewrite the references that pointed at the OLD paths, and never fail the
 * rename for it.
 *
 * Every path the SUBTREE carried, not just the root, which is why the moves
 * are derived here rather than written by the caller. The rename itself
 * already stands by the time this runs, so both failure modes — some
 * documents unrewritten, or the pass throwing outright — are a log line and
 * a partially repaired workspace, never a failed rename.
 */
async function followRenameAndLog(
  deps: ServerDeps,
  {
    workspaceId,
    entriesBefore,
    from,
    to,
  }: {
    workspaceId: string
    entriesBefore: Awaited<ReturnType<DocumentIndex['listDocuments']>>
    from: string
    to: string
  },
): Promise<void> {
  const moves = movesForPathChange(entriesBefore, from, to)
  if (moves.length === 0) return
  try {
    const follow = await followReferencesAfterRename(deps, { workspaceId, entriesBefore, moves })
    if (follow.failedDocumentIds.length > 0) {
      getLogger('document').warning(
        { workspaceId, from, to, failed: follow.failedDocumentIds },
        'rename followed references, but some documents could not be rewritten',
      )
    }
  } catch (err) {
    getLogger('document').warning(
      { workspaceId, from, to, err },
      'rename succeeded but the reference follow pass failed',
    )
  }
}

/**
 * One workspace's row in the listing: what the registry holds, plus the two
 * things only a per-row read can answer.
 *
 * Taken one row at a time by its caller, which is load-bearing — see the
 * SQLITE_BUSY note there before making this concurrent.
 */
async function summarizeWorkspace(
  deps: ServerDeps,
  options: WorkspacesRouterOptions,
  row: { workspaceId: string; segment?: string; displayName?: string },
) {
  return {
    workspaceId: row.workspaceId,
    ...(row.segment === undefined ? {} : { segment: row.segment }),
    ...(row.displayName === undefined ? {} : { displayName: row.displayName }),
    documentCount: await countDocuments(deps.documentIndex, row.workspaceId),
    ...(options.replicaTier === undefined
      ? {}
      : { tier: await options.replicaTier(row.workspaceId) }),
  }
}

export function createWorkspacesRouter(options: WorkspacesRouterOptions = {}) {
  const app = new Hono()

  app.get('/api/workspaces', async (c) => {
    try {
      const deps = options.serverDeps ?? (await getDefaultServerDeps())
      // Straight to the PORT, for the same reason the rename is (ADR-0018):
      // listing workspaces is the port call and nothing else, so a use case
      // here would forward no arguments and add a name.
      const workspaces = await deps.documentIndex.listWorkspaces()
      // The count costs a document listing per row, which the tree index
      // answers by OPENING each workspace's record — so this turns a registry
      // read into N of them.
      //
      // SEQUENTIAL, and that is the load-bearing part. `Promise.all` over the
      // rows opens N workspace records at once against the one SQLite file,
      // and on a real daemon holding real workspaces that made the whole
      // listing fail with `SQLITE_BUSY: database is locked` — a 500 for every
      // row because of contention this route introduced. A/B against a live
      // daemon: concurrent 500, sequential 200. The contention itself is not
      // reproducible here (each test gets a fresh, idle database), so the
      // DECISION is pinned instead: workspaces.test.ts asserts the per-row
      // listings never overlap, and a Promise.all revert fails it.
      //
      // The cost that buys: measured end-to-end over HTTP against that same
      // daemon — 11 workspaces, 38 documents — best of 7 is 4.2ms, on a
      // control a person opens by clicking. Revisit if this list ever feeds
      // something that polls.
      const counted = []
      for (const row of workspaces) {
        // ponytail: N x membersOnly (one PK lookup) per list — a batched
        // query is the upgrade path if this shows up in a profile. Checked
        // before the per-row documentCount read, so a filtered-out row costs no tree open.
        if (
          options.admit !== undefined &&
          (await options.admit(c, row.workspaceId)) !== 'admitted'
        ) {
          continue
        }
        // Awaited IN the loop, never gathered: see the note above.
        counted.push(await summarizeWorkspace(deps, options, row))
      }
      const response: ListWorkspacesResponse = { workspaces: counted }
      return c.json(response)
    } catch (err) {
      const owned = firstOwned(err, [corruptStored])
      if (owned) return c.json(owned.body, owned.status)
      throw err
    }
  })

  // POST /api/workspaces  body: { displayName }
  //
  // Straight to the PORT, like the list above and for the same ADR-0018
  // reason: creating a workspace IS the port call, and a use case here would
  // forward its arguments and add a name.
  app.post('/api/workspaces', async (c) => {
    const parsed = createWorkspaceRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ title: 'displayName is required' } satisfies ApiErrorBody, 400)
    }
    const { displayName } = parsed.data

    try {
      const deps = options.serverDeps ?? (await getDefaultServerDeps())
      const workspaceId = generateDocumentId()
      const base = deriveWorkspaceSegment(displayName)
      const segment =
        base === undefined ? undefined : await firstFreeSegment(deps.documentIndex, base)

      await deps.documentIndex.createWorkspace({
        workspaceId,
        ...(segment === undefined ? {} : { segment }),
        displayName,
      })
      const response: WorkspaceSummary = {
        workspaceId,
        ...(segment === undefined ? {} : { segment }),
        displayName,
      }
      return c.json(response, 201)
    } catch (err) {
      // A segment the suffix loop believed free can still be taken by the
      // time the insert lands. The registry's own unique index is what
      // actually decides, and it reports the same named error a rename does.
      const owned = firstOwned(err, [segmentTaken, corruptStored])
      if (owned) return c.json(owned.body, owned.status)
      throw err
    }
  })

  // PATCH /api/workspaces/:workspaceId  body: { segment?, displayName? }
  //
  // PATCH, not PUT: a field ABSENT means "leave this layer alone", which is
  // the port's contract and something PUT cannot express — under PUT a body
  // carrying only a name would be asking to drop the address.
  app.patch('/api/workspaces/:workspaceId', async (c) => {
    const handle = c.req.param('workspaceId')
    const invalidWorkspaceId = refusedBy(() => validateWorkspaceId(handle))
    if (invalidWorkspaceId) return c.json(invalidWorkspaceId, 400)
    const parsed = renameWorkspaceRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ title: 'segment or displayName must be valid' } satisfies ApiErrorBody, 400)
    }

    try {
      const deps = options.serverDeps ?? (await getDefaultServerDeps())
      // Resolved through the handle, so this route accepts either layer in
      // the address exactly as every other addressed surface does.
      const workspaceId = await workspaceIdFromHandle(c, handle)
      const renamed = await deps.documentIndex.renameWorkspace({ workspaceId, ...parsed.data })
      const response: WorkspaceSummary = {
        workspaceId: renamed.workspaceId,
        ...(renamed.segment === undefined ? {} : { segment: renamed.segment }),
        ...(renamed.displayName === undefined ? {} : { displayName: renamed.displayName }),
      }
      return c.json(response)
    } catch (err) {
      const owned = firstOwned(err, [
        segmentTaken,
        workspaceNotFoundAs(`Workspace "${handle}" not found`),
        corruptStored,
      ])
      if (owned) return c.json(owned.body, owned.status)
      throw err
    }
  })

  app.get('/api/workspaces/:workspaceId/documents', async (c) => {
    const handle = c.req.param('workspaceId')
    const invalidWorkspaceId = refusedBy(() => validateWorkspaceId(handle))
    if (invalidWorkspaceId) return c.json(invalidWorkspaceId, 400)
    const workspaceId = await workspaceIdFromHandle(c, handle)
    try {
      const deps = options.serverDeps ?? (await getDefaultServerDeps())
      const { documents } = await wbDocumentList(deps, { workspaceId })
      // The port names a document by the id the index assigned and calls what
      // a human reads its `name`; this surface has always said `id` and
      // `displayName`. Renaming either would be a published break for a
      // translation an adapter is there to do.
      const response: ListDocumentsResponse = {
        documents: documents.map((entry) => ({
          path: entry.path,
          id: entry.documentId,
          ...(entry.name === undefined ? {} : { displayName: entry.name }),
          ...(entry.kind === undefined ? {} : { kind: entry.kind }),
          ...(entry.updatedAt === undefined ? {} : { updatedAt: entry.updatedAt }),
          ...(entry.shadowed === undefined ? {} : { shadowed: entry.shadowed }),
        })),
      }
      return c.json(response)
    } catch (err) {
      // "Empty" and "never registered" are different answers, and conflating
      // them is what let a stale pairing render as an empty workspace with a
      // Create button. The operation refuses an unknown workspace rather than
      // answering with an empty list, which is what makes this translation
      // possible without a second existence query.
      //
      // So the two cases a client must tell apart are: a workspace that
      // exists and holds nothing answers 200 with an empty array, and only an
      // ABSENT one answers 404. A 404 here therefore means gone, never empty.
      const owned = firstOwned(err, [
        workspaceNotFoundAs(`Workspace "${workspaceId}" not found`),
        corruptStored,
      ])
      if (owned) return c.json(owned.body, owned.status)
      throw err
    }
  })

  // Save a new empty LoroDoc under path. Return 409 for conflicts and 400 for invalid paths.
  // On success, return { path } for client-side navigation.
  app.post('/api/workspaces/:workspaceId/documents', async (c) => {
    const handle = c.req.param('workspaceId')
    const invalidWorkspaceId = refusedBy(() => validateWorkspaceId(handle))
    if (invalidWorkspaceId) {
      return c.json({ title: invalidWorkspaceId.message } satisfies ApiErrorBody, 400)
    }
    const workspaceId = await workspaceIdFromHandle(c, handle)
    const body = await jsonBody(c, createDocumentRequestSchema, createDocumentRequestErrorTitle)
    if ('refusal' in body) return c.json(body.refusal, 400)
    const path = body.data.path
    const invalidDocumentPath = refusedBy(() => validateDocumentPath(path))
    if (invalidDocumentPath) {
      return c.json({ title: invalidDocumentPath.message } satisfies ApiErrorBody, 400)
    }
    try {
      const deps = options.serverDeps ?? (await getDefaultServerDeps())
      await wbDocumentCreate(deps, {
        workspaceId,
        path,
        kind: body.data.kind,
        // Kept, and now safe. `saveDocument` used to upsert the workspace
        // row on the way past, so posting into a workspace that does not
        // exist has always worked here — the one surface that opted out of
        // "workspaces never materialize implicitly".
        //
        // Under ADR-0019's mint boundary the flag no longer risks a phantom:
        // it resolves first, so an existing workspace is a no-op, and a
        // handle that names nothing is either minted with that handle as its
        // segment or refused (400) when it cannot be one — which is what a
        // browser posting a canonical id for a workspace the daemon no
        // longer has now gets, instead of a silent new workspace.
        //
        // Removing it outright is a real improvement and a SEPARATE
        // increment: measured, six other suites bootstrap their fixtures by
        // POSTing here, so it is a 20-test fixture change rather than the
        // no-op `workspaces.test.ts` alone suggests.
        createWorkspace: true,
        // Passed through as given. A blank name meaning "no name" is the
        // OPERATION's rule now, not a second copy of it here — two places
        // normalising the same field is two places that can stop agreeing.
        ...(body.data.name === undefined ? {} : { name: body.data.name }),
      })
      const response: CreateDocumentResponse = { path }
      return c.json(response)
    } catch (err) {
      // `segmentUnusable` is the refusal the comment above promises: a handle
      // that names nothing and cannot be a segment is the caller's to change.
      const owned = firstOwned(err, [
        pathTakenAs(`Canvas "${path}" already exists`),
        segmentUnusable,
      ])
      if (owned) return c.json(owned.body, owned.status)
      getLogger('document').error({ err: err as Error }, 'wbDocumentCreate failed unexpectedly')
      return c.json({ title: 'Failed to create canvas.' } satisfies ApiErrorBody, 500)
    }
  })

  // Delete a canvas: row (branches/versions cascade via FK), .loro blob,
  // version thumbnails, and doc-cache entry. Idempotent-shaped 404 for a
  // missing canvas rather than a throw.
  //
  // An ADAPTER over `wbDocumentDelete` (ADR-0018), not a second
  // implementation of it. The two were separate sequences performing the
  // same delete, and only one of them cleaned up; sharing the pieces closed
  // that gap once, and sharing the operation is what stops the next piece
  // from drifting. All this translates is the ADDRESS — this surface names a
  // document by path, the operation by the id the index assigned — and the
  // absent case, which is a 404 here and a throw there.
  onDocumentsRoute(
    app,
    'delete',
    [],
    async (c, workspaceId, path) => {
      try {
        const deps = options.serverDeps ?? (await getDefaultServerDeps())
        const entry = await deps.documentIndex.resolveDocument({ workspaceId, path })
        if (entry === null) {
          return c.json({ title: `Canvas "${path}" not found` }, 404)
        }
        await wbDocumentDelete(deps, { workspaceId, documentId: entry.documentId })
        const response: DeleteDocumentResponse = { ok: true }
        return c.json(response)
      } catch (err) {
        // The tree index refuses an unknown workspace with a throw where the
        // retired SQL index answered null; this surface's spelling of both
        // is the same 404.
        const owned = firstOwned(err, [
          workspaceNotFoundAs(`Canvas "${path}" not found`),
          hasDescendants,
          corruptStored,
        ])
        if (owned) return c.json(owned.body, owned.status)
        getLogger('document').error({ err: err as Error }, 'wbDocumentDelete failed unexpectedly')
        return c.json({ title: 'Failed to delete canvas.' } satisfies ApiErrorBody, 500)
      }
    },
    { badRequest: 'problem-details' },
  )

  // Rename a canvas's path in place: same documentId, same branches/versions/blob,
  // just a new path column. Old URLs carrying the old path 404 by design — no
  // redirect, no alias history (0.0.x).
  //
  // An ADAPTER over `documentIndex.moveDocument` (ADR-0018). Straight to the
  // port rather than through a `wb_document_*` operation, because there is no
  // operation to write: a move is the port call and nothing else, so a use
  // case here would forward one argument set and add a name. The delete and
  // create differ — each composes several steps that a second surface would
  // otherwise repeat.
  //
  // The web app's move/rename UI reaches exactly this route
  // (`WorkspaceFilesPanel` -> `daemon-files-source` -> `PUT …/documents/:path/path`),
  // so a stale comment here claiming nothing called it has been removed.
  onDocumentsRoute(
    app,
    'put',
    ['path'],
    async (c, workspaceId, path) => {
      const body = await jsonBody(c, renameDocumentPathRequestSchema, 'path is required')
      if ('refusal' in body) return c.json(body.refusal, 400)
      const newPath = body.data.path
      const invalidDocumentPath = refusedBy(() => validateDocumentPath(newPath))
      if (invalidDocumentPath) {
        return c.json({ title: invalidDocumentPath.message } satisfies ApiErrorBody, 400)
      }
      try {
        const deps = options.serverDeps ?? (await getDefaultServerDeps())
        // The listing BEFORE the move is the table the old path resolved
        // against; the follow pass needs it and only this side of the
        // mutation can take it.
        const entriesBefore = await deps.documentIndex.listDocuments({ workspaceId })
        await deps.documentIndex.moveDocument({ workspaceId, from: path, to: newPath })
        await followRenameAndLog(deps, { workspaceId, entriesBefore, from: path, to: newPath })
        const response: RenameDocumentPathResponse = { path: newPath }
        return c.json(response)
      } catch (err) {
        // Absent is a 404 here and a throw there — the same translation the
        // delete makes, in the opposite direction. An unknown WORKSPACE is
        // the same answer: nothing at that address.
        //
        // The path collision forwards the RAISED message rather than
        // rebuilding one from newPath: a subtree move collides on a PRODUCED
        // path, so the path the caller asked for is often free and naming it
        // sends them to retry the one thing that was never the problem.
        const owned = firstOwned(err, [
          notFoundAs(`Canvas "${path}" not found`),
          moveIntoSelf,
          pathTakenAs(),
          corruptStored,
        ])
        if (owned) return c.json(owned.body, owned.status)
        getLogger('document').error({ err: err as Error }, 'moveDocument failed unexpectedly')
        return c.json({ title: 'Failed to rename canvas.' } satisfies ApiErrorBody, 500)
      }
    },
    { badRequest: 'problem-details' },
  )

  return app
}
