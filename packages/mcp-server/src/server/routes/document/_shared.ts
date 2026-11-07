import { userInfo } from 'node:os'
import type {
  CreateWorkspaceRefusal,
  saveVersionRequestSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import { workspaceNotFoundRefusal } from '@kamiazya/whiteboard-daemon-client/api-contracts/membership'
import {
  DocumentHasDescendantsError,
  DocumentMoveIntoSelfError,
  DocumentPathTakenError,
  isDisplayNameTakenError,
  isDocumentNotFoundError,
  isWorkspaceNotFoundError,
  TooManyDocumentsError,
  TooManyFoldersError,
  TooManyWorkspacesError,
  WorkspaceSegmentTakenError,
} from '@kamiazya/whiteboard-ports'
import {
  type ApiErrorBody,
  errorBody,
  issueText,
  type ServerDeps,
  WorkspaceNotFoundForCallerError,
} from '@kamiazya/whiteboard-server-core'
import type { Context, MiddlewareHandler } from 'hono'
import type { z } from 'zod'
import type { CallerName } from '../../security/membership-gate.js'
import { corruptStoredDataBody } from '../../store/corrupt-stored-data.js'
import { validationErrorBody } from '../../validators.js'
import { callerNamespaceOf, refuseMalformedHandle } from '../../workspace-handle.js'

function defaultHumanDisplayName(): string {
  try {
    const name = userInfo().username.trim()
    if (name.length > 0) return name
  } catch {
    /* ignore */
  }
  return 'human'
}

/** An operator as a request may state it: everything but the device. */
type StatedOperator = NonNullable<z.infer<typeof saveVersionRequestSchema>['operator']>

/**
 * Who a row a person asked for names, before the keeper stamps its device.
 *
 * Where the keeper knows its caller (`callerName`, server mode), the row
 * names that member and nothing the request stated: any member could
 * otherwise save under another's name, and an unnamed save would carry the
 * server's OS account rather than anyone who used it. Where it does not (the
 * local daemon, one person), the request's own operator stands, and the OS
 * account is that person.
 */
export async function personOperator(
  c: Context,
  callerName: CallerName | undefined,
  requested?: StatedOperator,
): Promise<StatedOperator> {
  if (callerName === undefined) {
    return requested ?? { kind: 'human', displayName: defaultHumanDisplayName() }
  }
  const displayName = await callerName(c)
  return displayName === null ? { kind: 'human' } : { kind: 'human', displayName }
}

export function handleCorruptStoredData(
  err: unknown,
): { status: 500; body: { error: 'corrupt_stored_data'; message: string } } | null {
  const body = corruptStoredDataBody(err)
  if (body) return { status: 500, body }
  return null
}

/**
 * Metadata writers (names, pins, version save) refuse a path with
 * no document instead of minting a phantom row; routes answer that refusal
 * as 404 — the caller named a document that does not exist.
 */
function handleDocumentNotFound(
  err: unknown,
): { status: 404; body: { error: 'not_found'; message: string } } | null {
  if (isDocumentNotFoundError(err)) {
    return { status: 404, body: { error: 'not_found', message: err.message } }
  }
  return null
}

/**
 * One translation from a thrown error to an HTTP answer, or null when this
 * layer does not own that error.
 *
 * The shape `handleCorruptStoredData` and `handleDocumentNotFound` above
 * already have, named so a route can list the ones it means.
 */
export type ErrorAnswer = (
  err: unknown,
) => { status: 400 | 404 | 409 | 413 | 500; body: ApiErrorBody } | null

/**
 * The first translation that owns `err`, or null for the caller to rethrow.
 *
 * One translator replaces a per-route chain of `if (err instanceof …) return
 * c.json(…)`, which is most of what made handlers hard to read. The SET stays at the call site on purpose: which errors a
 * route answers is part of what that route means, and a single translator
 * applied everywhere would silently start answering errors a handler lets
 * through as a 500.
 */
export function firstOwned(
  err: unknown,
  answers: readonly ErrorAnswer[],
): { status: 400 | 404 | 409 | 413 | 500; body: ApiErrorBody } | null {
  for (const answer of answers) {
    const owned = answer(err)
    if (owned !== null) return owned
  }
  return null
}

/**
 * What reading or writing a stored document can be refused for: the path names
 * no document, or the stored record is unreadable. Routes over a document's
 * stored state share this set; the SET a route owns is still its own choice.
 */
export const STORED_DOCUMENT_ANSWERS: readonly ErrorAnswer[] = [
  handleDocumentNotFound,
  handleCorruptStoredData,
]

/**
 * A display name a sibling of the same kind already shows: only the caller
 * can pick another, and the message names the folder it collided in.
 */
export const displayNameTaken: ErrorAnswer = (err) =>
  isDisplayNameTakenError(err)
    ? { status: 409, body: errorBody('display_name_taken', err.message) }
    : null

/**
 * A new document or folder past the workspace's ceiling for it, in the code
 * the sync routes answer it with, so a client reads one refusal however it
 * minted.
 */
export const pastWorkspaceCeiling: ErrorAnswer = (err) =>
  err instanceof TooManyDocumentsError || err instanceof TooManyFoldersError
    ? { status: 413, body: errorBody(err.code, err.message) }
    : null

/** A create in a namespace already holding the most workspaces one person may. */
export const pastNamespaceCeiling: ErrorAnswer = (err) => {
  if (!(err instanceof TooManyWorkspacesError)) return null
  const body: CreateWorkspaceRefusal = { error: err.code, message: err.message }
  return { status: err.status, body }
}

/** A conflicting workspace segment: another workspace already holds it. */
export const segmentTaken: ErrorAnswer = (err) =>
  err instanceof WorkspaceSegmentTakenError
    ? { status: 409, body: errorBody('workspace_segment_taken', err.message) }
    : null

/**
 * A move into the document's own subtree is an unusable TARGET, not a race
 * with another document — 400, not 409.
 */
export const moveIntoSelf: ErrorAnswer = (err) =>
  err instanceof DocumentMoveIntoSelfError
    ? { status: 400, body: errorBody('document_move_into_self', err.message) }
    : null

/**
 * A path collision. The MESSAGE is the caller's, because the two routes that
 * answer this mean different things by it: creating at a path the caller
 * named can say so, while a subtree MOVE collides on a path the mover
 * PRODUCED — naming the one the caller asked for sends them to retry the
 * thing that was never the problem, so that route forwards the raised
 * message instead.
 */
export const pathTakenAs =
  (message?: string): ErrorAnswer =>
  (err) =>
    err instanceof DocumentPathTakenError
      ? { status: 409, body: errorBody('document_path_taken', message ?? err.message) }
      : null

/** A refusal, not a failure: the caller has to name what it destroys. */
export const hasDescendants: ErrorAnswer = (err) =>
  err instanceof DocumentHasDescendantsError
    ? { status: 409, body: errorBody('document_has_descendants', err.message) }
    : null

/**
 * An absent workspace has two spellings that reach a route: the index's own
 * error, and the tool layer's `WorkspaceNotFoundForCallerError` from a route
 * that delegates to a tool. Both are the one condition to a caller.
 */
const isWorkspaceAbsent = (err: unknown): boolean =>
  isWorkspaceNotFoundError(err) || err instanceof WorkspaceNotFoundForCallerError

/**
 * The workspace being absent, in the one voice every route answers it in.
 * Both error spellings carry the id the caller's address resolved to.
 */
export const workspaceNotFound: ErrorAnswer = (err) =>
  isWorkspaceAbsent(err)
    ? {
        status: 404,
        body: workspaceNotFoundRefusal((err as { workspaceId: string }).workspaceId),
      }
    : null

/**
 * Nothing at that address: an absent DOCUMENT answers the message the caller
 * supplies (only the route knows which path it was asked for), an absent
 * WORKSPACE answers as every other route does.
 */
export const notFoundAs =
  (message: string): ErrorAnswer =>
  (err) =>
    isDocumentNotFoundError(err)
      ? { status: 404, body: errorBody('not_found', message) }
      : workspaceNotFound(err)

/**
 * Refuses an unknown workspace before any `/api/workspaces/:workspaceId/*`
 * route runs, in `workspaceNotFoundRefusal`'s voice.
 *
 * A middleware rather than a check in each handler: handlers that read a
 * workspace's store answer an unknown one with an EMPTY result (names, version
 * lists, a purge that frees nothing), and a write to it does nothing or mints a
 * row for a workspace that does not exist, so each route's own translation of
 * "absent" would have to be remembered. It also covers routers mounted after
 * the one that registers it (the files router), which a call per route could
 * not without threading deps into it.
 *
 * A malformed handle passes through: an address no workspace can have is the
 * caller's mistake, and each route words that 400 itself. In
 * server mode the membership gate sits in front and answers a stranger the same
 * refusal for an unknown workspace as for a real one, so this cannot be used to
 * learn which workspaces exist.
 */
export function refuseUnknownWorkspace(deps: Pick<ServerDeps, 'documentIndex'>): MiddlewareHandler {
  return async (c, next) => {
    const handle = c.req.param('workspaceId') ?? ''
    if (refuseMalformedHandle(c, handle) !== null) return next()
    // The index `/api/v1` asks, and for the same reason: it takes either layer
    // of the address (ADR-0019) and is the registry the operations read.
    if ((await deps.documentIndex.resolveWorkspace(handle, callerNamespaceOf(c))) === null) {
      return c.json(workspaceNotFoundRefusal(handle), 404)
    }
    await next()
  }
}

/** Stored data this server cannot read — a 500 that says which. */
export const corruptStored: ErrorAnswer = (err) => handleCorruptStoredData(err)

/**
 * `resolveDocumentAddress`'s answer for a workspace record it cannot read:
 * the id is resolved ahead of the handler, so the record is met there, and
 * the composition words the refusal as every route does. A failure that is
 * not corrupt stored data is rethrown by the resolver.
 */
export const refuseCorruptStored = (err: unknown, c: Context): Response | null => {
  const corrupt = handleCorruptStoredData(err)
  return corrupt === null ? null : c.json(corrupt.body, corrupt.status)
}

/**
 * A validator's refusal, or null when it passed.
 *
 * Every addressed route here opens with the same five lines — call the
 * validator, catch, ask `validationErrorBody` whether the throw was a
 * refusal, rethrow if it was not — which is a phase rather than a step, and
 * reads as one now. The RETHROW is the part worth keeping explicit: a
 * validator that fails for some other reason is a fault, not a 400.
 *
 * The refusal it answers is already a body in the error contract.
 */
export function refusedBy(validate: () => void): { error: string; message: string } | null {
  try {
    validate()
    return null
  } catch (err) {
    const body = validationErrorBody(err)
    if (body) return body
    throw err
  }
}

/**
 * Why a strict request body was refused, for a route whose own sentence names
 * the fields it wants.
 *
 * Request bodies are strict so a caller learns that a field it sent did not
 * take effect — which only works if the refusal says so. A fixed sentence
 * ("displayName is required") is right for a missing or mistyped field and
 * wrong for a key the daemon does not know, where it accuses a field the
 * caller DID send: a newer page posting a new field to an older daemon is
 * sent looking in the wrong place. So an unrecognised key is named, and the
 * route's own sentence answers everything else.
 */
export function refusalReason(error: z.ZodError, fallback: string): string {
  const unknown = error.issues.filter((issue) => issue.code === 'unrecognized_keys')
  return unknown.length === 0 ? fallback : unknown.map(issueText).join('; ')
}

/** `refusalReason` as the `invalid_body` refusal a strict request body answers. */
export const invalidBodyRefusal = (
  error: z.ZodError,
  fallback: string,
): { error: 'invalid_body'; message: string } => ({
  error: 'invalid_body',
  message: refusalReason(error, fallback),
})
