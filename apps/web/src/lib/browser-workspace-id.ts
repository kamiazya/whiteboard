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
  | { readonly kind: 'resolved'; readonly workspaceId: string }
  | { readonly kind: 'failed'; readonly cause: unknown }

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
  switch (state.kind) {
    case 'resolved':
      return state.workspaceId
    case 'unresolved':
      throw new Error(
        'browser workspace id read before resolveBrowserWorkspaceId() completed — ' +
          'await it in the boot chain, or use the test seam',
      )
    case 'failed':
      throw new Error(`browser workspace unavailable: ${causeMessage(state.cause)}`)
  }
}

async function readSoleWorkspaceId(dbName: string | undefined): Promise<string> {
  const db = await openWhiteboardDb(dbName)
  try {
    return await new Promise<string>((resolve, reject) => {
      const tx = db.transaction(WORKSPACES_STORE, 'readonly')
      const req = tx.objectStore(WORKSPACES_STORE).getAllKeys()
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
        resolve(canonical.data)
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
  if (state.kind === 'resolved') return state.workspaceId
  if (inFlight !== null) return inFlight
  const attempt = readSoleWorkspaceId(dbName)
    .then((workspaceId) => {
      state = { kind: 'resolved', workspaceId }
      inFlight = null
      return workspaceId
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

/** Test seam: resolve synchronously to a fixed id, without opening a database. */
export function setBrowserWorkspaceIdForTests(workspaceId: string): void {
  state = { kind: 'resolved', workspaceId }
  inFlight = null
}

/** Test seam: return to the unresolved state, as at module load. */
export function resetBrowserWorkspaceIdForTests(): void {
  state = { kind: 'unresolved' }
  inFlight = null
}
