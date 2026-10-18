import type { UpdateDocumentResponse } from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import { workspaceNotFoundRefusal } from '@kamiazya/whiteboard-daemon-client/api-contracts/membership'
import {
  PROMOTE_REQUEST_LIMIT_BYTES,
  type PromoteWorkspaceRequest,
  type PromoteWorkspaceResponse,
  promoteWorkspaceRequestSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/promotion'
import {
  applyWorkspaceDocumentUpdate,
  errorBody,
  type OperatorInfo,
  promoteWorkspace,
  type ServerDeps,
  syncWriteAnswer,
} from '@kamiazya/whiteboard-server-core'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { LoroDoc } from 'loro-crdt'
import { getLogger } from '../../log.js'
import type { CallerName } from '../../security/membership-gate.js'
import { validateWorkspaceId, validationErrorBody } from '../../validators.js'
import { workspaceIdFromHandle } from '../../workspace-handle.js'
import { CONTENT_BODY_LIMIT_BYTES, limitContentBody } from '../body-limit.js'
import { type ReadJsonBodyOptions, readJsonBody } from '../read-json-body.js'
import { personOperator } from './_shared.js'

export interface WorkspaceDocumentRouterOptions {
  triggerAutoVersion: (workspaceId: string, path: string, doc: LoroDoc) => void
  // The workspace-document seam the routes read and write through, handed
  // down from document.ts.
  serverDeps: ServerDeps
  /** This daemon as an OKF actor — see `VersionsRouterOptions.daemonActor`. */
  daemonActor?: string
  /** Who the caller is, where the keeper knows — see `VersionsRouterOptions.callerName`. */
  callerName?: CallerName
}

// The workspace-granularity sync surface (order 7 of the workspace-document
// design): one snapshot/update pair for the whole workspace document. The
// protocol already carried a docRef per message; what changes here is only
// the granularity of the subscription.
//
// Translation-only adapters (ADR-0018): the reads go through the
// WorkspaceDocuments seam, and the update path — lock bracket, import,
// persist, projection eviction — lives in server-core's
// applyWorkspaceDocumentUpdate.
//
// GET  /api/w/:workspaceId/workspace-document/snapshot
// POST /api/w/:workspaceId/workspace-document/update
/**
 * The preamble all three workspace-document routes share: the handle as
 * written is validated (so a malformed one keeps its 400), resolved to a
 * canonical id, and the workspace is checked to EXIST.
 *
 * That last check is the honesty rule this surface runs on: an unregistered
 * workspace is a refusal, not a phantom. Inside a registered workspace a
 * missing workspace document is minted empty — the workspace is real, it
 * just has no tree-plane documents yet.
 */
async function admittedWorkspace(
  c: Context,
  deps: ServerDeps,
): Promise<{ workspaceId: string; deps: ServerDeps } | { refusal: Response }> {
  // The route cannot match without the segment; `?? ''` is for the type,
  // and an empty handle refuses through the same validator as any other
  // unusable one rather than through a second path.
  const handle = c.req.param('workspaceId') ?? ''
  // Validated here, not through `parseWorkspaceHandle`: this surface is read
  // by the page, which speaks Problem Details (`{ title }`), where the helper
  // answers the `{ error, message }` family.
  try {
    validateWorkspaceId(handle)
  } catch (err) {
    const body = validationErrorBody(err)
    if (body) return { refusal: c.json({ title: body.message }, 400) }
    throw err
  }
  const workspaceId = await workspaceIdFromHandle(c, handle)
  if (!(await deps.workspaceDocuments.exists(workspaceId))) {
    return { refusal: c.json(workspaceNotFoundRefusal(handle), 404) }
  }
  return { workspaceId, deps }
}

/**
 * A write that threw one of the refusals the operations raise rather than
 * return, answered the way every sync surface answers it (`syncWriteAnswer`).
 * Nothing of a refused write is kept.
 */
function answerWriteRefusal(c: Context, err: unknown): Response {
  const answer = syncWriteAnswer(err)
  if (answer === undefined) throw err
  return c.json(errorBody(answer.code, (err as Error).message), answer.status)
}

// The contract's ceiling, which the sender fits its body to — derived there
// from the same file ceiling CONTENT_BODY_LIMIT_BYTES is.
const PROMOTE_BODY: ReadJsonBodyOptions = {
  voice: 'code',
  maxBytes: PROMOTE_REQUEST_LIMIT_BYTES,
  refuseShape: () =>
    errorBody(
      'invalid_body',
      'snapshot must be base64url, and trash and versions the carried planes',
    ),
}

/** The planes carried beside the record, their base64url decoded. */
function decodeCarried(body: PromoteWorkspaceRequest) {
  const bytes = (text: string) => new Uint8Array(Buffer.from(text, 'base64url'))
  return {
    trash: (body.trash ?? []).map((carried) => ({
      documentId: carried.documentId,
      bytes: bytes(carried.bytes),
    })),
    versions: (body.versions ?? []).map((version) => ({
      ...version,
      frontiers: bytes(version.frontiers),
    })),
  }
}

/**
 * Carried versions as server mode records them: each row names the member
 * who carried it, as `personOperator` names the move's own checkpoint,
 * because what the request states about who saved a row is the caller's
 * word and server mode does not take a member's word for who another member
 * is. A row is dated no later than the move — a future date would outrank
 * every later checkpoint in the newest-first history, the auto-version cap
 * and the unchanged-since check — while an earlier date and `auto` stand:
 * the move keeps a history's dates, and the row now reads as the claim of
 * the member it names. With no caller name (the local daemon, one person),
 * the rows stand as stated.
 */
async function attributedToCaller(
  c: Context,
  callerName: CallerName | undefined,
  carried: ReturnType<typeof decodeCarried>,
): Promise<ReturnType<typeof decodeCarried>> {
  if (callerName === undefined) return carried
  const operator = await personOperator(c, callerName)
  const now = Date.now()
  return {
    ...carried,
    versions: carried.versions.map((version) => ({
      ...version,
      operator,
      createdAt: Math.min(version.createdAt, now),
    })),
  }
}

// Promotion (ADR-0023): the browser keeper's whole record merged in, as the
// update route would merge it, with the trash bytes and saved versions it
// points at, plus one explicit human checkpoint per promoted document — the
// promote is a person's explicit act.
//
// No keeper here holds a passkey pin (ADR-0050 decision 3 retired the local
// daemon's, and server mode never had any), so the contract has no place for
// an attestation: a body carrying one is refused by the strict schema, before
// the merge, rather than dropped — a caller that sent evidence learns it was
// not checked.
//
// POST /api/w/:workspaceId/workspace-document/promote
function promoteHandler(options: WorkspaceDocumentRouterOptions) {
  return async (c: Context): Promise<Response> => {
    const admitted = await admittedWorkspace(c, options.serverDeps)
    if ('refusal' in admitted) return admitted.refusal
    const { workspaceId, deps } = admitted
    const body = await readJsonBody(c, promoteWorkspaceRequestSchema, PROMOTE_BODY)
    if ('refusal' in body) return body.refusal
    const snapshot = new Uint8Array(Buffer.from(body.data.snapshot, 'base64url'))
    const carried = await attributedToCaller(c, options.callerName, decodeCarried(body.data))

    // The device that wrote the row (ADR-0035 decision 2), as every other
    // human row this daemon writes.
    const operator: OperatorInfo = {
      ...(await personOperator(c, options.callerName)),
      ...(options.daemonActor === undefined ? {} : { actor: options.daemonActor }),
    }
    let result: Awaited<ReturnType<typeof promoteWorkspace>>
    try {
      result = await promoteWorkspace(deps, { workspaceId, snapshot, operator, ...carried })
    } catch (err) {
      return answerWriteRefusal(c, err)
    }
    if (result.kind === 'malformed-snapshot') {
      return c.json(errorBody('malformed_snapshot', 'Malformed workspace record snapshot'), 400)
    }
    if (result.kind === 'unmatched-carried') {
      return c.json(errorBody('unmatched_carried', result.reason), 400)
    }
    if (result.kind === 'too-many-documents') {
      // The message names the count, the limit and the way out, for whoever reads it.
      return c.json(
        errorBody(
          'promote_too_many_documents',
          `This workspace holds ${result.documents} documents; one move carries at most ${result.limit}. ` +
            'Move some documents to another workspace first, then move this one.',
        ),
        413,
      )
    }
    const response: PromoteWorkspaceResponse = {
      ok: true,
      recorded: [...result.recorded],
      shadowed: [...result.shadowed],
      trashStored: [...result.trashStored],
      versionsKept: [...result.versionsKept],
    }
    return c.json(response)
  }
}

/**
 * Signals every document an update edited, as the per-document route signals
 * the one it wrote; the checkpoint lands once each goes quiet. One document at
 * a time, after the response: an update may edit as many documents as a
 * workspace holds, and each signal loads that document's projection, so
 * starting them together would hold every projection at once. A failure is
 * logged and never fails the update or the documents after it.
 */
async function signalEdited(
  options: WorkspaceDocumentRouterOptions,
  deps: ServerDeps,
  workspaceId: string,
  edited: readonly { readonly path: string }[],
): Promise<void> {
  for (const { path } of edited) {
    try {
      const doc = await deps.liveDocuments.get(workspaceId, path)
      options.triggerAutoVersion(workspaceId, path, doc)
    } catch (err: unknown) {
      getLogger('document').error(
        { workspaceId, path, err: err as Error },
        'auto-version trigger failed',
      )
    }
  }
}

export function createWorkspaceDocumentRouter(options: WorkspaceDocumentRouterOptions) {
  const app = new Hono()

  app.get('/api/w/:workspaceId/workspace-document/snapshot', async (c) => {
    const admitted = await admittedWorkspace(c, options.serverDeps)
    if ('refusal' in admitted) return admitted.refusal
    const { workspaceId, deps } = admitted
    const doc = await deps.workspaceDocuments.get(workspaceId)
    const snapshot = doc.export({ mode: 'snapshot' }) as Uint8Array<ArrayBuffer>
    return c.body(snapshot, 200, { 'Content-Type': 'application/octet-stream' })
  })

  app.post(
    '/api/w/:workspaceId/workspace-document/update',
    limitContentBody(CONTENT_BODY_LIMIT_BYTES, 'Update'),
    async (c) => {
      const admitted = await admittedWorkspace(c, options.serverDeps)
      if ('refusal' in admitted) return admitted.refusal
      const { workspaceId, deps } = admitted
      const bytes = new Uint8Array(await c.req.arrayBuffer())

      let result: Awaited<ReturnType<typeof applyWorkspaceDocumentUpdate>>
      try {
        result = await applyWorkspaceDocumentUpdate(deps, { workspaceId, update: bytes })
      } catch (err) {
        return answerWriteRefusal(c, err)
      }
      if (result.kind === 'malformed-update') {
        return c.json(errorBody('invalid_body', 'Malformed workspace-document update'), 400)
      }

      void signalEdited(options, deps, workspaceId, result.edited)

      const response: UpdateDocumentResponse = { ok: true }
      return c.json(response)
    },
  )

  app.post(
    '/api/w/:workspaceId/workspace-document/promote',
    limitContentBody(PROMOTE_REQUEST_LIMIT_BYTES, 'Promotion'),
    promoteHandler(options),
  )

  return app
}
