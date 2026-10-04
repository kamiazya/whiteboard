import {
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
import { deriveWorkspaceSegment, generateDocumentId } from '@kamiazya/whiteboard-model'
import { type DocumentIndex, isWorkspaceNotFoundError } from '@kamiazya/whiteboard-ports'
import type { ApiErrorBody } from '@kamiazya/whiteboard-server-core'
import {
  type ServerDeps,
  type WbDocumentMoveResult,
  wbDocumentDelete,
  wbDocumentList,
  wbDocumentMove,
} from '@kamiazya/whiteboard-server-core'
import { firstFreeSegment } from '@kamiazya/whiteboard-workspace-index'
import { type Context, Hono } from 'hono'
import { getLogger } from '../../log.js'
import type { FirstMember, WorkspaceAdmit } from '../../security/membership-gate.js'
import { membershipRefusal } from '../../security/workspace-access.js'
import { validateDocumentPath } from '../../validators.js'
import {
  parseWorkspaceHandle,
  refuseMalformedHandle,
  workspaceIdFromHandle,
} from '../../workspace-handle.js'
import { readJsonBody } from '../read-json-body.js'
import {
  corruptStored,
  firstOwned,
  hasDescendants,
  moveIntoSelf,
  notFoundAs,
  pathTakenAs,
  refusedBy,
  segmentTaken,
  titleRefusal,
  workspaceNotFound,
} from './_shared.js'
import { onDocumentsRoute } from './path-route.js'

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
  /** The operations this router adapts onto, handed down by the root. */
  serverDeps: ServerDeps
  /** Resolves the read plane's effective tier per workspace (ADR-0042
   *  decisions 1/3/5). Absent means the listing omits `tier` — app.ts wires
   *  this from `options.replicaKeys?.effectiveTier` only when a replica-key
   *  store was supplied. */
  replicaTier?: (workspaceId: string) => Promise<ReplicaTier>
  /** The membership gate GET /api/workspaces filters the listing
   *  through, rather than refusing the whole request — a name is a leak to a
   *  non-member the way its content is. Absent means no filtering (server-
   *  mode, and any composition that has not wired members). */
  admit?: WorkspaceAdmit
  /** ADR-0046 decision 10: who becomes a new workspace's first member. Absent
   *  on the local daemon, where an unclaimed workspace is open by design. */
  firstMember?: FirstMember
}

// GET /api/workspaces
// GET /api/workspaces/:workspaceId/documents
// POST /api/workspaces/:workspaceId/documents  body: { path: string }
/**
 * The move is `wbDocumentMove`'s; what this surface adds is saying so when
 * the follow pass could not repair every reference. The operation returns
 * that outcome instead of logging it, because only the surface knows how it
 * reports — `wb_workspace_edit` answers it in the result row, this route
 * has only the log. The move stands either way, so neither case changes the
 * answer.
 */
function logFollowOutcome(workspaceId: string, moved: WbDocumentMoveResult): void {
  const { from, path: to } = moved
  if ('error' in moved.follow) {
    getLogger('document').warning(
      { workspaceId, from, to, err: moved.follow.error },
      'rename succeeded but the reference follow pass failed',
    )
  } else if (moved.follow.failedDocumentIds.length > 0) {
    getLogger('document').warning(
      { workspaceId, from, to, failed: moved.follow.failedDocumentIds },
      'rename followed references, but some documents could not be rewritten',
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

// The creating person's profile, `null` when this keeper makes no first
// member (the local daemon), or `refused` when it must and cannot.
async function creatorOf(
  c: Context,
  firstMember: FirstMember | undefined,
): Promise<string | null | 'refused'> {
  if (firstMember === undefined) return null
  return (await firstMember.profileFor(c)) ?? 'refused'
}

async function createWorkspaceRow(
  deps: ServerDeps,
  displayName: string,
): Promise<WorkspaceSummary> {
  const workspaceId = generateDocumentId()
  const base = deriveWorkspaceSegment(displayName)
  // Advisory: the registry's unique index decides, and the caller translates
  // its refusal when two creates both found the same candidate free.
  const taken = new Set((await deps.documentIndex.listWorkspaces()).map((w) => w.segment))
  const segment = base === undefined ? undefined : await firstFreeSegment(base, (s) => taken.has(s))
  await deps.documentIndex.createWorkspace({
    workspaceId,
    ...(segment === undefined ? {} : { segment }),
    displayName,
  })
  return { workspaceId, ...(segment === undefined ? {} : { segment }), displayName }
}

export function createWorkspacesRouter(options: WorkspacesRouterOptions) {
  const app = new Hono()

  app.get('/api/workspaces', async (c) => {
    try {
      const deps = options.serverDeps
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
        // ponytail: N x (profileForBinding + isWorkspaceMember) per list — two
        // lookups a row, the first answering the same person every time; a
        // batched membership query is the upgrade path if this shows up in a
        // profile. Checked
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
    const body = await readJsonBody(c, createWorkspaceRequestSchema, {
      voice: 'problem',
      refuseShape: (error) => titleRefusal(error, 'displayName is required'),
    })
    if ('refusal' in body) return body.refusal
    const { displayName } = body.data
    // Decided before anything is created: a workspace nobody can be the
    // first member of is one nobody could open.
    const creator = await creatorOf(c, options.firstMember)
    if (creator === 'refused') return c.json(membershipRefusal('requires_person_session'), 403)

    try {
      const deps = options.serverDeps
      const summary = await createWorkspaceRow(deps, displayName)
      if (creator !== null) await options.firstMember?.add(summary.workspaceId, creator)
      return c.json(summary, 201)
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
    const malformed = refuseMalformedHandle(c, handle)
    if (malformed !== null) return malformed
    const parsed = await readJsonBody(c, renameWorkspaceRequestSchema, {
      voice: 'problem',
      refuseShape: (error) => titleRefusal(error, 'segment or displayName must be valid'),
    })
    if ('refusal' in parsed) return parsed.refusal

    try {
      const deps = options.serverDeps
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
      const owned = firstOwned(err, [segmentTaken, workspaceNotFound, corruptStored])
      if (owned) return c.json(owned.body, owned.status)
      throw err
    }
  })

  app.get('/api/workspaces/:workspaceId/documents', async (c) => {
    const address = await parseWorkspaceHandle(c, c.req.param('workspaceId'))
    if ('refusal' in address) return address.refusal
    const { workspaceId } = address
    try {
      const deps = options.serverDeps
      // The operation's own rows are this response's rows: re-listing its
      // fields here is how `pinned` went unanswered while the tool and
      // `/api/v1` carried it.
      const { documents } = await wbDocumentList(deps, { workspaceId })
      const response: ListDocumentsResponse = { documents }
      return c.json(response)
    } catch (err) {
      // "Empty" and "never registered" are different answers, and conflating
      // them lets a client holding a stale workspace id render it as an empty
      // workspace with a Create button. The operation refuses an unknown
      // workspace rather than answering with an empty list, which is what makes
      // this translation possible without a second existence query.
      //
      // So the two cases a client must tell apart are: a workspace that
      // exists and holds nothing answers 200 with an empty array, and only an
      // ABSENT one answers 404. A 404 here therefore means gone, never empty.
      const owned = firstOwned(err, [workspaceNotFound, corruptStored])
      if (owned) return c.json(owned.body, owned.status)
      throw err
    }
  })

  // Delete a document: row (versions cascade via FK), .loro blob, and
  // doc-cache entry. Idempotent-shaped 404 for a
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
        const deps = options.serverDeps
        const entry = await deps.documentIndex.resolveDocument({ workspaceId, path })
        if (entry === null) {
          return c.json({ title: `Document "${path}" not found` }, 404)
        }
        await wbDocumentDelete(deps, { workspaceId, documentId: entry.documentId })
        const response: DeleteDocumentResponse = { ok: true }
        return c.json(response)
      } catch (err) {
        // The tree index refuses an unknown workspace with a throw where the
        // retired SQL index answered null; both are a 404.
        const owned = firstOwned(err, [workspaceNotFound, hasDescendants, corruptStored])
        if (owned) return c.json(owned.body, owned.status)
        getLogger('document').error({ err: err as Error }, 'wbDocumentDelete failed unexpectedly')
        return c.json({ title: 'Failed to delete document.' } satisfies ApiErrorBody, 500)
      }
    },
    { badRequest: 'problem-details' },
  )

  // Rename a document's path in place: same documentId, same versions and
  // bytes, just a new placement. Old URLs carrying the old path 404 by
  // design — no redirect, no alias history (0.0.x).
  //
  // An ADAPTER over `wbDocumentMove` (ADR-0018), which composes the listing,
  // the index mutation and the follow pass over references to the old path;
  // `wb_workspace_edit`'s `document.move` op is the same operation's other
  // surface. All this translates is the ADDRESS — this surface names a
  // document by path, the operation by its id — and the absent case, a 404
  // here and a throw there, the way the delete above does.
  //
  // The web app's move/rename UI reaches exactly this route
  // (`WorkspaceFilesPanel` -> `daemon-files-source` -> `PUT …/documents/:path/path`).
  onDocumentsRoute(
    app,
    'put',
    ['path'],
    async (c, workspaceId, path) => {
      const body = await readJsonBody(c, renameDocumentPathRequestSchema, {
        voice: 'problem',
        refuseShape: (error) => titleRefusal(error, 'path is required'),
      })
      if ('refusal' in body) return body.refusal
      const newPath = body.data.path
      const invalidDocumentPath = refusedBy(() => validateDocumentPath(newPath))
      if (invalidDocumentPath) {
        return c.json({ title: invalidDocumentPath.message } satisfies ApiErrorBody, 400)
      }
      try {
        const deps = options.serverDeps
        const entry = await deps.documentIndex.resolveDocument({ workspaceId, path })
        if (entry === null) {
          return c.json({ title: `Document "${path}" not found` }, 404)
        }
        const moved = await wbDocumentMove(deps, {
          workspaceId,
          documentId: entry.documentId,
          path: newPath,
        })
        logFollowOutcome(workspaceId, moved)
        const response: RenameDocumentPathResponse = { path: newPath }
        return c.json(response)
      } catch (err) {
        // Absent is a 404 here and a throw there — the same translation the
        // delete makes, in the opposite direction. An unknown WORKSPACE is
        // not a missing document: it answers as it does everywhere else.
        //
        // The path collision forwards the RAISED message rather than
        // rebuilding one from newPath: a subtree move collides on a PRODUCED
        // path, so the path the caller asked for is often free and naming it
        // sends them to retry the one thing that was never the problem.
        const owned = firstOwned(err, [
          notFoundAs(`Document "${path}" not found`),
          moveIntoSelf,
          pathTakenAs(),
          corruptStored,
        ])
        if (owned) return c.json(owned.body, owned.status)
        getLogger('document').error({ err: err as Error }, 'moveDocument failed unexpectedly')
        return c.json({ title: 'Failed to rename document.' } satisfies ApiErrorBody, 500)
      }
    },
    { badRequest: 'problem-details' },
  )

  return app
}
