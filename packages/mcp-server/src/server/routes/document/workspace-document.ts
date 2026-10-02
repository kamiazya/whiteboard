import type { UpdateDocumentResponse } from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import {
  type PromoteWorkspaceResponse,
  promoteWorkspaceRequestSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/promotion'
import { resolveWorkspaceDocumentById } from '@kamiazya/whiteboard-loro-adapter'
import {
  applyWorkspaceDocumentUpdate,
  type OperatorInfo,
  promoteWorkspace,
  type ServerDeps,
} from '@kamiazya/whiteboard-server-core'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { LoroDoc } from 'loro-crdt'
import { getLogger } from '../../log.js'
import { validateWorkspaceId, validationErrorBody } from '../../validators.js'
import { workspaceIdFromHandle } from '../../workspace-handle.js'
import { defaultHumanDisplayName } from './_shared.js'

// Same ceiling as the per-document update path: a workspace-granularity
// update carries the same kind of Loro delta, just scoped wider.
const WORKSPACE_DOC_UPDATE_LIMIT_BYTES = 16 * 1024 * 1024
// The same record, base64url-inflated by 4/3 inside a JSON body.
const WORKSPACE_DOC_PROMOTE_LIMIT_BYTES = 24 * 1024 * 1024

export interface WorkspaceDocumentRouterOptions {
  triggerAutoVersion: (workspaceId: string, path: string, doc: LoroDoc) => void
  // The workspace-document seam the routes read and write through, handed
  // down from document.ts.
  serverDeps: ServerDeps
  /** This daemon as an OKF actor — see `VersionsRouterOptions.daemonActor`. */
  daemonActor?: string
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
// POST /api/w/:workspaceId/workspace-document/update?documentId=<ulid>
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
    return { refusal: c.json({ title: `Workspace "${workspaceId}" not found` }, 404) }
  }
  return { workspaceId, deps }
}

/**
 * The wire shape as the promotion itself wants it: the snapshot decoded, and
 * whether the browser sent an attestation beside it.
 */
function promoteRequestFrom(json: unknown):
  | { snapshot: Uint8Array; attested: boolean }
  | {
      error: { error: string; message: string }
    } {
  const parsed = promoteWorkspaceRequestSchema.safeParse(json)
  if (!parsed.success) {
    return {
      error: {
        error: 'invalid_body',
        message: 'snapshot must be base64url and attestation, if present, a WebAuthn assertion',
      },
    }
  }
  return {
    snapshot: new Uint8Array(Buffer.from(parsed.data.snapshot, 'base64url')),
    attested: parsed.data.attestation !== undefined,
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
    bodyLimit({
      maxSize: WORKSPACE_DOC_UPDATE_LIMIT_BYTES,
      onError: (c) =>
        c.json(
          {
            error: 'payload_too_large',
            message: `Update exceeds ${WORKSPACE_DOC_UPDATE_LIMIT_BYTES} bytes limit.`,
          },
          413,
        ),
    }),
    async (c) => {
      const admitted = await admittedWorkspace(c, options.serverDeps)
      if ('refusal' in admitted) return admitted.refusal
      const { workspaceId, deps } = admitted
      const bytes = new Uint8Array(await c.req.arrayBuffer())

      const result = await applyWorkspaceDocumentUpdate(deps, { workspaceId, update: bytes })
      if (result === 'malformed-update') {
        return c.json({ title: 'Malformed workspace-document update' }, 400)
      }

      // Signal the document the client says it is editing. The checkpoint
      // lands once it goes quiet; failures never fail the update itself.
      const documentId = c.req.query('documentId')
      if (documentId !== undefined) {
        void (async () => {
          const workspaceDoc = await deps.workspaceDocuments.get(workspaceId)
          const entry = resolveWorkspaceDocumentById(workspaceDoc, documentId)
          if (entry === null) return
          const doc = await deps.liveDocuments.get(workspaceId, entry.path)
          options.triggerAutoVersion(workspaceId, entry.path, doc)
        })().catch((err: unknown) => {
          getLogger('document').error({ err: err as Error }, 'auto-version trigger failed')
        })
      }

      const response: UpdateDocumentResponse = { ok: true }
      return c.json(response)
    },
  )

  // Promotion (ADR-0023): the browser keeper's whole record merged in, as the
  // update route would merge it, plus one explicit human checkpoint per
  // promoted document — the promote is a person's explicit act.
  //
  // No keeper here holds a passkey pin (ADR-0050 decision 3 retired the local
  // daemon's, and server mode never had any), so an attestation can name no
  // credential this keeper knows. It is refused before the merge rather than
  // dropped: a refused promote changes nothing, and a caller that sent
  // evidence is told it was not checked instead of reading `attested: false`
  // as a verdict.
  //
  // POST /api/w/:workspaceId/workspace-document/promote
  app.post(
    '/api/w/:workspaceId/workspace-document/promote',
    bodyLimit({
      maxSize: WORKSPACE_DOC_PROMOTE_LIMIT_BYTES,
      onError: (c) =>
        c.json(
          {
            error: 'payload_too_large',
            message: `Promotion exceeds ${WORKSPACE_DOC_PROMOTE_LIMIT_BYTES} bytes limit.`,
          },
          413,
        ),
    }),
    async (c) => {
      const admitted = await admittedWorkspace(c, options.serverDeps)
      if ('refusal' in admitted) return admitted.refusal
      const { workspaceId, deps } = admitted
      let json: unknown
      try {
        json = await c.req.json()
      } catch {
        return c.json({ error: 'invalid_body', message: 'malformed JSON' }, 400)
      }
      const request = promoteRequestFrom(json)
      if ('error' in request) return c.json(request.error, 400)
      if (request.attested) {
        return c.json({ error: 'attestation_rejected', message: 'unknownCredential' }, 403)
      }
      const { snapshot } = request

      // The device that wrote the row (ADR-0035 decision 2), as every other
      // human row this daemon writes.
      const operator: OperatorInfo = {
        kind: 'human',
        displayName: defaultHumanDisplayName(),
        ...(options.daemonActor === undefined ? {} : { actor: options.daemonActor }),
      }
      const result = await promoteWorkspace(deps, {
        workspaceId,
        snapshot,
        operator,
      })
      if (result.kind === 'malformed-snapshot') {
        return c.json({ title: 'Malformed workspace record snapshot' }, 400)
      }
      const response: PromoteWorkspaceResponse = {
        ok: true,
        attested: false,
        recorded: [...result.recorded],
        shadowed: [...result.shadowed],
      }
      return c.json(response)
    },
  )

  return app
}
