import { userInfo } from 'node:os'
import {
  DocumentHasDescendantsError,
  DocumentMoveIntoSelfError,
  DocumentPathTakenError,
  isWorkspaceNotFoundError,
  WorkspaceSegmentTakenError,
} from '@kamiazya/whiteboard-ports'
import type { ApiErrorBody } from '@kamiazya/whiteboard-server-core'
import { WorkspaceSegmentUnusableError } from '@kamiazya/whiteboard-server-core'
import { corruptStoredDataBody } from '../../store/corrupt-stored-data.js'
import { DocumentNotFoundError } from '../../store/document-not-found-error.js'
import { validationErrorBody } from '../../validators.js'

export function defaultHumanDisplayName(): string {
  try {
    const name = userInfo().username.trim()
    if (name.length > 0) return name
  } catch {
    /* ignore */
  }
  return 'human'
}

export function handleCorruptStoredData(
  err: unknown,
): { status: 500; body: { error: 'corrupt_stored_data'; message: string } } | null {
  const body = corruptStoredDataBody(err)
  if (body) return { status: 500, body }
  return null
}

/**
 * Metadata writers (names, pins, branches, version save) refuse a path with
 * no document instead of minting a phantom row; routes answer that refusal
 * as 404 — the caller named a document that does not exist.
 */
export function handleDocumentNotFound(
  err: unknown,
): { status: 404; body: { error: 'not_found'; message: string } } | null {
  if (err instanceof DocumentNotFoundError) {
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
) => { status: 400 | 404 | 409 | 500; body: ApiErrorBody } | null

/**
 * The first translation that owns `err`, or null for the caller to rethrow.
 *
 * Each route here walked its own chain of `if (err instanceof …) return
 * c.json(…)`, four or five deep, which is most of what made these handlers
 * hard to read. The SET stays at the call site on purpose: which errors a
 * route answers is part of what that route means, and a single translator
 * applied everywhere would silently start answering errors a handler used to
 * let through as a 500.
 */
export function firstOwned(
  err: unknown,
  answers: readonly ErrorAnswer[],
): { status: 400 | 404 | 409 | 500; body: ApiErrorBody } | null {
  for (const answer of answers) {
    const owned = answer(err)
    if (owned !== null) return owned
  }
  return null
}

/** A conflicting workspace segment: another workspace already holds it. */
export const segmentTaken: ErrorAnswer = (err) =>
  err instanceof WorkspaceSegmentTakenError ? { status: 409, body: { title: err.message } } : null

/**
 * A move into the document's own subtree is an unusable TARGET, not a race
 * with another document — 400, not 409.
 */
export const moveIntoSelf: ErrorAnswer = (err) =>
  err instanceof DocumentMoveIntoSelfError ? { status: 400, body: { title: err.message } } : null

/**
 * A path collision. The TITLE is the caller's, because the two routes that
 * answer this mean different things by it: creating at a path the caller
 * named can say so, while a subtree MOVE collides on a path the mover
 * PRODUCED — naming the one the caller asked for sends them to retry the
 * thing that was never the problem, so that route forwards the raised
 * message instead.
 */
export const pathTakenAs =
  (title?: string): ErrorAnswer =>
  (err) =>
    err instanceof DocumentPathTakenError
      ? { status: 409, body: { title: title ?? err.message } }
      : null

/** A refusal, not a failure: the caller has to name what it destroys. */
export const hasDescendants: ErrorAnswer = (err) =>
  err instanceof DocumentHasDescendantsError ? { status: 409, body: { title: err.message } } : null

/**
 * A handle that names nothing and cannot be a workspace SEGMENT is the
 * caller's to change, not a failure of ours.
 */
export const segmentUnusable: ErrorAnswer = (err) =>
  err instanceof WorkspaceSegmentUnusableError
    ? { status: 400, body: { title: err.message } }
    : null

/**
 * Nothing at that address. The WORKSPACE being absent and the DOCUMENT being
 * absent are one answer to a caller who named a document — which is why the
 * title is the caller's to supply.
 *
 * Matched by NAME rather than by `instanceof`, because there are TWO
 * `DocumentNotFoundError` classes — `server/store/`'s and `ports`' — and a
 * route has no business knowing which layer raised the one it got. An
 * `instanceof` against either misses the other silently: the rename route
 * imported ports' and answered 500 for a store-raised absence until a test
 * caught it. `isWorkspaceNotFoundError` already reads its own this way.
 */
export const notFoundAs =
  (title: string): ErrorAnswer =>
  (err) =>
    (err instanceof Error && err.name === 'DocumentNotFoundError') || isWorkspaceNotFoundError(err)
      ? { status: 404, body: { title } }
      : null

/** Only the WORKSPACE half of the above, for a route with no document in its address. */
export const workspaceNotFoundAs =
  (title: string): ErrorAnswer =>
  (err) =>
    isWorkspaceNotFoundError(err) ? { status: 404, body: { title } } : null

/** Stored data this server cannot read — a 500 that says which. */
export const corruptStored: ErrorAnswer = (err) => handleCorruptStoredData(err)

/**
 * A validator's refusal, or null when it passed.
 *
 * Every addressed route here opens with the same five lines — call the
 * validator, catch, ask `validationErrorBody` whether the throw was a
 * refusal, rethrow if it was not — which is a phase rather than a step, and
 * reads as one now. The RETHROW is the part worth keeping explicit: a
 * validator that fails for some other reason is a fault, not a 400.
 *
 * It answers the RAW refusal rather than a body, because the routes here do
 * not agree on what a refusal looks like on the wire: three answer Problem
 * Details (`{ title }`) and two answer the legacy `{ error, message }`. That
 * drift is real and is not this helper's to decide — a route that wants
 * Problem Details writes `{ title: refusal.message }` itself, and pinning
 * which is which is `workspaces.test.ts`'s job.
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
 * A request body parsed under `schema`, or the 400 that refuses it.
 *
 * Two refusals, not one: a body that is not JSON at all and a body that is
 * JSON of the wrong shape are different mistakes, and a caller can only act
 * on the difference if the route says which.
 */
export async function jsonBody<T, E>(
  c: { req: { json: () => Promise<unknown> } },
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: E } },
  // A function where the title is read off the parse error, which is how a
  // route says WHICH field it refused rather than only that it did.
  shapeTitle: string | ((error: E) => string),
): Promise<{ data: T } | { refusal: ApiErrorBody }> {
  const raw = await c.req.json().catch(() => null)
  if (raw === null) return { refusal: { title: 'JSON body required' } }
  const parsed = schema.safeParse(raw)
  if (parsed.success && parsed.data !== undefined) return { data: parsed.data }
  const title = typeof shapeTitle === 'string' ? shapeTitle : shapeTitle(parsed.error as E)
  return { refusal: { title } }
}
