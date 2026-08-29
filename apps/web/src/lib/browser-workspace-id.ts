/**
 * The browser's own workspace id — a synchronous accessor over an id that
 * can only be discovered asynchronously (an IndexedDB open + read).
 *
 * The split exists because most of this app's browser-workspace call sites
 * are synchronous with respect to the id itself (they build a request object
 * or a `DocRef` inline, inside an already-async function) and turning every
 * one of them `async` would ripple through call signatures that have nothing
 * to do with storage. `resolveBrowserWorkspaceId()` runs once, early (the
 * boot chain — see `boot.ts`), and every later read is this cheap
 * synchronous accessor.
 *
 * Three states, matching what a caller can actually be told:
 * - unresolved: nobody has awaited `resolveBrowserWorkspaceId()` yet.
 * - resolved: the canonical ULID a v14+ database's `workspaces` store holds.
 * - failed: the resolve attempt rejected (a stale tab blocking the upgrade,
 *   a quota failure, Safari private browsing). Retryable — the failure is
 *   surfaced, not remembered forever, because closing the offending tab or
 *   freeing quota is a normal recovery a reload should not be required for.
 */
import { workspaceCanonicalIdSchema } from '@kamiazya/whiteboard-model'
import { openWhiteboardDb, WORKSPACES_STORE } from './browser-idb.js'

type ResolutionState =
  | { readonly kind: 'unresolved' }
  | { readonly kind: 'resolved'; readonly identity: BrowserWorkspaceIdentity }
  | { readonly kind: 'failed'; readonly cause: unknown }

/**
 * The browser workspace's own record of ADR-0019's layers — the canonical id
 * every store keys on, and the segment an address shows.
 *
 * `segment` is optional because absent is a state a workspace can really be
 * in: a registry row written before the v15 carrier has none, and the
 * one-argument test seam mints none. A caller addressing such a workspace
 * falls back to the id, which is what that layer is for.
 */
export interface BrowserWorkspaceIdentity {
  readonly workspaceId: string
  readonly segment?: string
}

let state: ResolutionState = { kind: 'unresolved' }

// Coalesces concurrent callers onto the SAME open+read rather than racing two
// upgrade transactions against each other. Cleared on both settle paths so a
// later call after a failure re-attempts instead of replaying the rejection.
let inFlight: Promise<string> | null = null

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * The resolved id, or a throw naming which of the two non-resolved states
 * this is — a caller's `catch` (or its own local error isolation) sees a
 * message it can act on instead of a generic IndexedDB error.
 */
export function getBrowserWorkspaceId(): string {
  return getBrowserWorkspaceIdentity().workspaceId
}

/**
 * The whole identity, for the callers that need to ADDRESS this workspace
 * rather than key storage by it.
 *
 * Separate from `getBrowserWorkspaceId` rather than replacing it: some twenty
 * call sites read the id to build a `DocRef` or an IndexedDB key, and none of
 * them has any business knowing the workspace has a name.
 */
export function getBrowserWorkspaceIdentity(): BrowserWorkspaceIdentity {
  switch (state.kind) {
    case 'resolved':
      return state.identity
    case 'unresolved':
      throw new Error(
        'browser workspace id read before resolveBrowserWorkspaceId() completed — ' +
          'await it in the boot chain, or use the test seam',
      )
    case 'failed':
      throw new Error(`browser workspace unavailable: ${causeMessage(state.cause)}`)
  }
}

async function readSoleWorkspaceIdentity(
  dbName: string | undefined,
): Promise<BrowserWorkspaceIdentity> {
  const db = await openWhiteboardDb(dbName)
  try {
    return await new Promise<BrowserWorkspaceIdentity>((resolve, reject) => {
      const tx = db.transaction(WORKSPACES_STORE, 'readonly')
      const store = tx.objectStore(WORKSPACES_STORE)
      const req = store.getAllKeys()
      req.onsuccess = () => {
        const keys = req.result
        // The v14 migration converges on exactly one row (see browser-idb.ts's
        // rekeyBrowserWorkspace); anything else means the migration did not
        // run or did not converge, which is a bug this should surface loudly
        // rather than silently guess a key.
        if (keys.length !== 1) {
          reject(new Error(`expected exactly one browser workspace, found ${keys.length}`))
          return
        }
        // The SHAPE is checked too, not only the count. A single row keyed
        // `'local'` is exactly what a rekey that silently did not run leaves
        // behind, and caching it would put every later read and write under
        // an id ADR-0019 says cannot exist — indistinguishable from working,
        // until a keeper comparison or a promotion reads it.
        const sole = String(keys[0])
        const canonical = workspaceCanonicalIdSchema.safeParse(sole)
        if (!canonical.success) {
          reject(new Error(`browser workspace is not keyed by a canonical id: ${sole}`))
          return
        }
        // A second read, rather than `getAll()` alone: the shape check above
        // is on the KEY, and that is deliberate — a row keyed `'local'` is
        // exactly what a rekey that never ran leaves behind, and its VALUE
        // says `'local'` too, so validating the value would pass the check
        // for the same reason it should fail.
        const valueReq = store.get(sole)
        valueReq.onsuccess = () => {
          const row = valueReq.result as { segment?: unknown } | undefined
          const segment = typeof row?.segment === 'string' ? row.segment : undefined
          resolve({
            workspaceId: canonical.data,
            ...(segment === undefined ? {} : { segment }),
          })
        }
        valueReq.onerror = () => reject(valueReq.error)
      }
      req.onerror = () => reject(req.error)
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

/**
 * Opens the whiteboard database (running the v14+ migration if needed) and
 * caches the one canonical workspace id it holds. Safe to call from more than
 * one boot path or consumer — a resolved id is served from cache, and
 * concurrent unresolved calls share one open.
 */
export async function resolveBrowserWorkspaceId(dbName?: string): Promise<string> {
  if (state.kind === 'resolved') return state.identity.workspaceId
  if (inFlight !== null) return inFlight
  const attempt = readSoleWorkspaceIdentity(dbName)
    .then((identity) => {
      state = { kind: 'resolved', identity }
      inFlight = null
      return identity.workspaceId
    })
    .catch((cause: unknown) => {
      state = { kind: 'failed', cause }
      inFlight = null
      throw cause
    })
  inFlight = attempt
  return attempt
}

/**
 * The id, or null when it is unavailable.
 *
 * For a caller whose own failure path is already a null — a deep link that
 * falls through to the default document, say. Such a caller otherwise has to
 * read the id in an ARGUMENT position, where a throw precedes the promise and
 * escapes the `.catch` that was supposed to absorb it, turning a graceful
 * fallback into a rejected load.
 */
export function browserWorkspaceIdOrNull(): string | null {
  try {
    return getBrowserWorkspaceId()
  } catch {
    return null
  }
}

/**
 * The handle an ADDRESS should carry for this workspace, or null while the
 * identity is unavailable.
 *
 * Null rather than a throw for the reason `browserWorkspaceIdOrNull` exists:
 * `boot.ts` deliberately does not gate the app on the IndexedDB open, so a
 * render can reach a URL builder before the resolve lands, or after it
 * failed. Every caller here reads this in an ARGUMENT position, where a throw
 * precedes the promise and escapes the catch meant to absorb it.
 *
 * A null caller declines to navigate. That is the same rule
 * `navigateToDocument` already follows for a reference it cannot place — an
 * address that cannot name its workspace is not an address, and going
 * somewhere wrong is worse than staying put.
 */
export function browserWorkspaceHandleOrNull(): string | null {
  try {
    const identity = getBrowserWorkspaceIdentity()
    return identity.segment ?? identity.workspaceId
  } catch {
    return null
  }
}

/** Test seam: resolve synchronously to a fixed identity, without opening a database. */
export function setBrowserWorkspaceIdForTests(workspaceId: string, segment?: string): void {
  state = {
    kind: 'resolved',
    identity: { workspaceId, ...(segment === undefined ? {} : { segment }) },
  }
  inFlight = null
}

/** Test seam: return to the unresolved state, as at module load. */
export function resetBrowserWorkspaceIdForTests(): void {
  state = { kind: 'unresolved' }
  inFlight = null
}
