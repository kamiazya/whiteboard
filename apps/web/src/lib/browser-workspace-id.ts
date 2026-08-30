/**
 * The browser's ACTIVE workspace — a synchronous accessor over an identity
 * that can only be discovered asynchronously (an IndexedDB open + read).
 *
 * The split exists because most of this app's browser-workspace call sites
 * are synchronous with respect to the id itself (they build a request object
 * or a `DocRef` inline, inside an already-async function) and turning every
 * one of them `async` would ripple through call signatures that have nothing
 * to do with storage. `resolveBrowserWorkspaceId()` runs once, early (the
 * boot chain — see `boot.ts`), and every later read is this cheap
 * synchronous accessor.
 *
 * It used to mean "the ONLY one", and enforced it: a registry holding more
 * than one row was rejected outright, so a second browser workspace did not
 * degrade the app, it stopped it booting. What decides which one is active is
 * the ADDRESS (ADR-0019), which is why the resolver takes a handle — the
 * accessor stays a singleton because the alternative is the ripple its own
 * rationale above rejects, and because a workspace switch settles the
 * outgoing workspace's writes before the incoming one mounts.
 *
 * Three states, matching what a caller can actually be told:
 * - unresolved: nobody has awaited `resolveBrowserWorkspaceId()` yet.
 * - resolved: a canonical ULID this database's `workspaces` store holds.
 * - failed: the resolve attempt rejected (a stale tab blocking the upgrade,
 *   a quota failure, Safari private browsing). Retryable — the failure is
 *   surfaced, not remembered forever, because closing the offending tab or
 *   freeing quota is a normal recovery a reload should not be required for.
 */
import { workspaceCanonicalIdSchema } from '@kamiazya/whiteboard-model'
import { resolveWorkspaceHandle } from '@kamiazya/whiteboard-ports'
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

// React's channel onto the state machine above. It exists because the resolve
// can settle AFTER first paint: `boot.ts` bounds its wait at 3s and renders
// degraded past it, which a stale tab blocking the IndexedDB version upgrade
// reaches for real. A module accessor nobody subscribes to then updates while
// React is already mounted, so nothing re-renders — the deep link stays on
// the index and every URL builder keeps answering null. That is not a slow
// start, it is an app that stays unusable until a reload.
const listeners = new Set<() => void>()

function setResolutionState(next: ResolutionState): void {
  state = next
  for (const listener of listeners) listener()
}

/** `useSyncExternalStore`'s subscribe half. */
export function subscribeBrowserWorkspaceIdentity(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * `useSyncExternalStore`'s snapshot half — the identity, or null while it is
 * unavailable.
 *
 * Stable by reference in both arms, which the hook requires: `identity` is
 * written once per resolve and never rebuilt, and the not-resolved arms all
 * answer the same `null`.
 */
export function browserWorkspaceIdentitySnapshot(): BrowserWorkspaceIdentity | null {
  return state.kind === 'resolved' ? state.identity : null
}

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

/**
 * Every workspace this database holds, as identities.
 *
 * Keys AND values, in one transaction. The values carry the segment an
 * address resolves through; the KEYS are what a canonical-shape check has to
 * read, because a row keyed `'local'` says `'local'` in its value too —
 * validating the value would pass the check for precisely the reason it
 * should fail.
 */
async function readRegistryEntries(
  dbName: string | undefined,
): Promise<BrowserWorkspaceIdentity[]> {
  const db = await openWhiteboardDb(dbName)
  try {
    return await new Promise<BrowserWorkspaceIdentity[]>((resolve, reject) => {
      const tx = db.transaction(WORKSPACES_STORE, 'readonly')
      const store = tx.objectStore(WORKSPACES_STORE)
      const keysReq = store.getAllKeys()
      const rowsReq = store.getAll()
      tx.onerror = () => reject(tx.error)
      tx.oncomplete = () => {
        const rows = rowsReq.result as { segment?: unknown }[]
        resolve(
          keysReq.result.map(String).map((workspaceId, i) => {
            const segment = rows[i]?.segment
            return { workspaceId, ...(typeof segment === 'string' ? { segment } : {}) }
          }),
        )
      }
    })
  } finally {
    db.close()
  }
}

async function readWorkspaceIdentity(
  dbName: string | undefined,
  handle: string | undefined,
): Promise<BrowserWorkspaceIdentity> {
  const entries = await readRegistryEntries(dbName)
  // The address decides which workspace is ACTIVE (ADR-0019), through ports'
  // one definition of segment-first-then-id. A handle naming nothing falls
  // back rather than refusing: a stale bookmark should still open the app,
  // and turning an unmatched name into not-found is the ROUTE layer's job,
  // where there is a page to say so. `switchBrowserWorkspace` is strict for
  // the opposite reason, and says so in place.
  const chosen =
    (handle === undefined ? null : resolveWorkspaceHandle(entries, handle)) ?? entries[0]
  if (chosen === undefined) throw new Error('no browser workspace exists')
  if (!workspaceCanonicalIdSchema.safeParse(chosen.workspaceId).success) {
    throw new Error(`browser workspace is not keyed by a canonical id: ${chosen.workspaceId}`)
  }
  return chosen
}

/**
 * Opens the whiteboard database (running the v14+ migration if needed) and
 * caches the one canonical workspace id it holds. Safe to call from more than
 * one boot path or consumer — a resolved id is served from cache, and
 * concurrent unresolved calls share one open.
 */
export async function resolveBrowserWorkspaceId(dbName?: string, handle?: string): Promise<string> {
  if (state.kind === 'resolved') return state.identity.workspaceId
  if (inFlight !== null) return inFlight
  const attempt = readWorkspaceIdentity(dbName, handle)
    .then((identity) => {
      inFlight = null
      setResolutionState({ kind: 'resolved', identity })
      return identity.workspaceId
    })
    .catch((cause: unknown) => {
      inFlight = null
      setResolutionState({ kind: 'failed', cause })
      throw cause
    })
  inFlight = attempt
  return attempt
}

/**
 * Re-points the active workspace at the one `handle` names, or answers null
 * when this registry holds no such workspace.
 *
 * The second door the resolve-once accessor needs. `resolveBrowserWorkspaceId`
 * serves every later call from cache — that is what makes the synchronous
 * accessor above possible — so without this a switch has to be a document
 * load, which is what ADR-0019's Decision says it should not be.
 *
 * STRICT where the boot resolve is lenient, and the asymmetry is deliberate.
 * Boot falls back to first-listed because a stale bookmark should still open
 * the app and there is no previous state worth keeping. A switch has one:
 * answering "go here" by going somewhere else, and then rewriting the address
 * to match a place nobody asked for, is worse than declining.
 *
 * Callers must settle the outgoing workspace's writes before calling — which
 * `BrowserBackend` does by capturing its workspace at enqueue rather than at
 * execution (flush-before-switch, pinned in `browser-backend.browser.test.tsx`).
 */
export async function switchBrowserWorkspace(
  handle: string,
  dbName?: string,
): Promise<BrowserWorkspaceIdentity | null> {
  const chosen = resolveWorkspaceHandle(await readRegistryEntries(dbName), handle)
  if (chosen === null) return null
  const identity: BrowserWorkspaceIdentity = {
    workspaceId: chosen.workspaceId,
    ...(chosen.segment === undefined ? {} : { segment: chosen.segment }),
  }
  inFlight = null
  setResolutionState({ kind: 'resolved', identity })
  return identity
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

/**
 * Whether an address names THIS browser workspace — by its segment, or by the
 * canonical id ADR-0019 keeps resolvable in the same position.
 *
 * Both layers, and that is the whole point: the id form is the DURABLE link,
 * the one that survives a rename. A comparison against the handle alone reads
 * only the layer the handle happened to pick, so the moment a workspace has a
 * segment its id-form address matches nothing — and the guarantee the id
 * layer exists to give is silently gone. This lives beside the identity
 * rather than at the call site because the call site has no business knowing
 * a workspace answers to two names.
 *
 * False while the identity is unavailable: an address cannot be shown to name
 * a workspace nobody can read.
 */
export function browserWorkspaceMatches(handle: string): boolean {
  try {
    const identity = getBrowserWorkspaceIdentity()
    return identity.segment === handle || identity.workspaceId === handle
  } catch {
    return false
  }
}

/** Test seam: resolve synchronously to a fixed identity, without opening a database. */
export function setBrowserWorkspaceIdForTests(workspaceId: string, segment?: string): void {
  inFlight = null
  // Through the notifying setter, like the real resolve: a seam that moved
  // the state without telling subscribers could not stand in for the
  // transition it exists to simulate, and the delayed-resolution test would
  // pass against production code that never notifies.
  setResolutionState({
    kind: 'resolved',
    identity: { workspaceId, ...(segment === undefined ? {} : { segment }) },
  })
}

/** Test seam: return to the unresolved state, as at module load. */
export function resetBrowserWorkspaceIdForTests(): void {
  inFlight = null
  setResolutionState({ kind: 'unresolved' })
}
