import { createHash } from 'node:crypto'
import type { UpdateDocumentResponse } from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import {
  type PromoteWorkspaceResponse,
  promoteWorkspaceRequestSchema,
  promotionChallengeInput,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/promotion'
import { resolveWorkspaceDocumentById } from '@kamiazya/whiteboard-loro-adapter'
import {
  type Attestation,
  applyWorkspaceDocumentUpdate,
  type OperatorInfo,
  promoteWorkspace,
  type ServerDeps,
} from '@kamiazya/whiteboard-server-core'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { LoroDoc } from 'loro-crdt'
import { getDefaultServerDeps } from '../../../di/default-server-deps.js'
import { getLogger } from '../../log.js'
import { decodeAttestation, verifyWebAuthnAssertion } from '../../security/webauthn-assertion.js'
import type { WebAuthnCredentialStore } from '../../security/webauthn-credential-store.js'
import { validateWorkspaceId, validationErrorBody } from '../../validators.js'
import { workspaceIdFromHandle } from '../../workspace-handle.js'
import { defaultHumanDisplayName } from './_shared.js'

// Same ceiling as the per-document update path: a workspace-granularity
// update carries the same kind of Loro delta, just scoped wider.
const WORKSPACE_DOC_UPDATE_LIMIT_BYTES = 16 * 1024 * 1024
// The same record, base64url-inflated by 4/3 inside a JSON body, plus the
// attestation beside it.
const WORKSPACE_DOC_PROMOTE_LIMIT_BYTES = 24 * 1024 * 1024

export interface WorkspaceDocumentRouterOptions {
  triggerAutoVersion: (workspaceId: string, path: string, doc: LoroDoc) => void
  // The workspace-document seam the routes read and write through.
  // Production wires this from document.ts; a router built without it falls
  // back to the same wiring via getDefaultServerDeps.
  serverDeps?: ServerDeps
  /**
   * The passkeys paired origins pinned (ADR-0039). Absent in a composition
   * with no pairing (server-mode), where a promote that brings an
   * attestation is refused as naming an unknown credential.
   */
  credentials?: WebAuthnCredentialStore
  /** This daemon as an OKF actor — see `VersionsRouterOptions.daemonActor`. */
  daemonActor?: string
}

const sha256 = (input: Uint8Array | string): Buffer => createHash('sha256').update(input).digest()

/**
 * What stands between a promote's attestation and the rows it will be
 * written on. The pin is looked up by the browser-enforced Origin header
 * and the credential the assertion names; the challenge is recomputed from
 * the TARGET handle and the exact bytes received, so the signature can only
 * vouch for this content into this workspace; and two facts the pin holds
 * are checked against what the assertion says — backup eligibility, which
 * is fixed for a credential's life (decision 3), and the sign count, which
 * must advance while either side counts (a clone, or a replay, does not).
 * Recording the count is the last step, so a refusal records nothing.
 */
function verifyPromotionAttestation(input: {
  attestation: Attestation
  originHeader: string | undefined
  handle: string
  snapshot: Uint8Array
  credentials: WebAuthnCredentialStore | undefined
}): { ok: true } | { ok: false; reason: string } {
  let origin: string
  try {
    if (input.originHeader === undefined) return { ok: false, reason: 'origin' }
    origin = new URL(input.originHeader).origin
  } catch {
    return { ok: false, reason: 'origin' }
  }
  const pin = input.credentials?.find(origin, input.attestation.credentialId) ?? null
  if (pin === null) return { ok: false, reason: 'unknownCredential' }
  const challenge = sha256(
    promotionChallengeInput({
      workspaceId: input.handle,
      snapshotDigest: sha256(input.snapshot).toString('base64url'),
    }),
  )
  const verdict = verifyWebAuthnAssertion(decodeAttestation(input.attestation), {
    challenge,
    origin,
    rpId: pin.rpId,
    publicKeyJwk: pin.publicKeyJwk,
  })
  if (!verdict.ok) return { ok: false, reason: verdict.reason }
  if (verdict.backupEligible !== pin.backupEligible) {
    return { ok: false, reason: 'backupEligibility' }
  }
  if (!input.credentials?.recordSignCount(origin, pin.credentialId, verdict.signCount)) {
    return { ok: false, reason: 'signCount' }
  }
  return { ok: true }
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
  depsOf: () => Promise<ServerDeps>,
): Promise<{ handle: string; workspaceId: string; deps: ServerDeps } | { refusal: Response }> {
  // The route cannot match without the segment; `?? ''` is for the type,
  // and an empty handle refuses through the same validator as any other
  // unusable one rather than through a second path.
  const handle = c.req.param('workspaceId') ?? ''
  try {
    validateWorkspaceId(handle)
  } catch (err) {
    const body = validationErrorBody(err)
    if (body) return { refusal: c.json({ title: body.message }, 400) }
    throw err
  }
  const workspaceId = await workspaceIdFromHandle(c, handle)
  const deps = await depsOf()
  if (!(await deps.workspaceDocuments.exists(workspaceId))) {
    return { refusal: c.json({ title: `Workspace "${workspaceId}" not found` }, 404) }
  }
  return { handle, workspaceId, deps }
}

/**
 * The wire shape as the promotion itself wants it: the snapshot decoded, and
 * the attestation only if the browser sent one (it is optional — a workspace
 * may be promoted without passkey evidence, and `attested` in the response
 * says which happened).
 */
function promoteRequestFrom(json: unknown):
  | { snapshot: Uint8Array; attestation: Attestation | undefined }
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
    attestation: parsed.data.attestation,
  }
}

/**
 * `null` for both the unattested request and the one whose evidence checks
 * out — the two are the same to this route, and only the response's
 * `attested` distinguishes them.
 */
function attestationRefusal(
  args: Omit<Parameters<typeof verifyPromotionAttestation>[0], 'attestation'> & {
    attestation: Attestation | undefined
  },
): { error: string; message: string } | null {
  if (args.attestation === undefined) return null
  const verdict = verifyPromotionAttestation({ ...args, attestation: args.attestation })
  return verdict.ok ? null : { error: 'attestation_rejected', message: verdict.reason }
}

export function createWorkspaceDocumentRouter(options: WorkspaceDocumentRouterOptions) {
  const app = new Hono()
  const depsOf = async (): Promise<ServerDeps> =>
    options.serverDeps ?? (await getDefaultServerDeps())

  app.get('/api/w/:workspaceId/workspace-document/snapshot', async (c) => {
    const admitted = await admittedWorkspace(c, depsOf)
    if ('refusal' in admitted) return admitted.refusal
    const { handle, workspaceId, deps } = admitted
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
      const admitted = await admittedWorkspace(c, depsOf)
      if ('refusal' in admitted) return admitted.refusal
      const { handle, workspaceId, deps } = admitted
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

  // Promotion (ADR-0023 + ADR-0039): the browser keeper's whole record
  // merged in, as the update route would merge it, plus one explicit human
  // checkpoint per promoted document carrying the person's evidence. The
  // attestation is verified BEFORE the merge: a refused promote changes
  // nothing. Without an attestation the rows are written all the same —
  // the promote is still a person's explicit act (decision 8); what the
  // badge loses is the evidence, which is the honest reading of a browser
  // that could not ask a passkey.
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
      const admitted = await admittedWorkspace(c, depsOf)
      if ('refusal' in admitted) return admitted.refusal
      const { handle, workspaceId, deps } = admitted
      let json: unknown
      try {
        json = await c.req.json()
      } catch {
        return c.json({ error: 'invalid_body', message: 'malformed JSON' }, 400)
      }
      const request = promoteRequestFrom(json)
      if ('error' in request) return c.json(request.error, 400)
      const { snapshot, attestation } = request

      const refusal = attestationRefusal({
        attestation,
        originHeader: c.req.header('origin'),
        handle,
        snapshot,
        credentials: options.credentials,
      })
      if (refusal) return c.json(refusal, 403)

      // The device that wrote the row (ADR-0035 decision 2), as every other
      // human row this daemon writes; the person's evidence is beside it.
      const operator: OperatorInfo = {
        kind: 'human',
        displayName: defaultHumanDisplayName(),
        ...(options.daemonActor === undefined ? {} : { actor: options.daemonActor }),
      }
      const result = await promoteWorkspace(deps, {
        workspaceId,
        snapshot,
        operator,
        ...(attestation === undefined ? {} : { attestation }),
      })
      if (result.kind === 'malformed-snapshot') {
        return c.json({ title: 'Malformed workspace record snapshot' }, 400)
      }
      const response: PromoteWorkspaceResponse = {
        ok: true,
        attested: attestation !== undefined,
        recorded: [...result.recorded],
        shadowed: [...result.shadowed],
      }
      return c.json(response)
    },
  )

  return app
}
