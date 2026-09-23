import type { WorkspaceRoute } from './app-routes.js'
import { browserWorkspaceMatches } from './browser-workspace-id.js'
import type { ConnectedDaemon } from './daemon-auth-fetch.js'
import type { ProviderState } from './provider.js'
import { findReplicaForHandle, type ReplicaMatch } from './replicas.js'
import type { UserSettings } from './user-settings-store.js'

/**
 * WHO KEEPS this session's workspace, and how to reach them — the derivations
 * `App` used to spell as four stacked ternaries among its thirty hooks.
 *
 * Pure, and here rather than in `App`, for the reason any decision chain is:
 * each answer is about its inputs alone, and a reader asking "which daemon is
 * the shell talking to?" should not have to hold a component's render order in
 * mind to find out.
 */

/**
 * The 'Work in this browser instead' escape hatch collapses a daemon OR
 * invalid-config state to browser capabilities, so every downstream consumer
 * (chip, banner, canvas page) reads THIS rather than the raw state —
 * otherwise the escape could leave daemon capabilities or copy leaking into a
 * mode the user explicitly opted out of, or bounce a failed-pairing escape
 * onto the invalid-config error page.
 */
export function effectiveProviderState(
  state: ProviderState,
  forcedBrowser: boolean,
): ProviderState {
  if (!forcedBrowser) return state
  if (state.kind === 'daemon' || state.kind === 'invalid-config') return { kind: 'browser' }
  return state
}

/**
 * Whether a daemon keeps this session's workspace.
 *
 * Decided by pairing and provider state — ADR-0004 settles it at page load —
 * and these are the same two conditions the render tail uses to choose a
 * daemon tree over the browser one. Derived rather than read off the address:
 * the URL's own shape (`/local/*`) used to answer this, which is exactly what
 * three-layer identity exists to stop, and that guard could not survive the
 * two route families becoming one.
 */
export function daemonKeepsSession({
  forcedBrowser,
  linkPaired,
  grantPaired,
  effectiveState,
}: {
  forcedBrowser: boolean
  linkPaired: boolean
  grantPaired: boolean
  effectiveState: ProviderState
}): boolean {
  if (effectiveState.kind === 'daemon') return true
  if (forcedBrowser) return false
  return linkPaired || grantPaired
}

/**
 * Which daemon the SHELL is talking to, resolved once from the three sources
 * the render branches each used to resolve for themselves: a `#wb=` pairing
 * payload, a completed grant exchange, or the configured provider state.
 *
 * A `#wb=` payload supplies the ADDRESS and never a credential, so the token
 * has exactly two sources: the pairing grant this page obtained, or the
 * daemon's own injection when it served the page.
 *
 * `undefined` under the 'Work in this browser instead' escape, which opts out
 * of every daemon the session might otherwise have reached.
 */
export function shellDaemon({
  forcedBrowser,
  linkPayloadBaseUrl,
  grant,
  effectiveState,
  injectedToken,
}: {
  forcedBrowser: boolean
  linkPayloadBaseUrl: string | undefined
  grant: { daemonBaseUrl: string; token: string } | null
  effectiveState: ProviderState
  injectedToken: string | undefined
}): { baseUrl: string; token: string | undefined } | undefined {
  if (forcedBrowser) return undefined
  const token = grant !== null ? grant.token : injectedToken
  if (linkPayloadBaseUrl !== undefined) return { baseUrl: linkPayloadBaseUrl, token }
  if (grant !== null) return { baseUrl: grant.daemonBaseUrl, token }
  if (effectiveState.kind === 'daemon') {
    return { baseUrl: effectiveState.daemonBaseUrl, token }
  }
  return undefined
}

/**
 * The daemon /settings talks to. It renders on its own route ahead of (and
 * independent from) the daemon/browser branch, so its connection is resolved
 * here rather than reusing a local that exists only inside one of those
 * branches' scope.
 */
export function settingsDaemon({
  forcedBrowser,
  grant,
  providerState,
  injectedToken,
}: {
  forcedBrowser: boolean
  grant: { daemonBaseUrl: string; token: string } | null
  providerState: ProviderState
  injectedToken: string | undefined
}): ConnectedDaemon | undefined {
  if (forcedBrowser) return undefined
  if (grant !== null) return { baseUrl: grant.daemonBaseUrl, token: grant.token }
  if (providerState.kind === 'daemon') {
    return { baseUrl: providerState.daemonBaseUrl, token: injectedToken ?? null }
  }
  return undefined
}

/**
 * What the browser shell has to say about this session, as ONE value: the two
 * banners are mutually exclusive outcomes of the same pairing attempt, and
 * spelling them as two independent conditions is how a reader has to work out
 * that they are.
 */
export type SessionBanner =
  | { kind: 'none' }
  | { kind: 'identity-mismatch' }
  | { kind: 'pairing-error'; detail: string }

/**
 * What the browser shell has to say about this session: an identity
 * verification that failed closed, a pairing that did not complete, or
 * nothing. One value rather than two independent conditions, because they are
 * outcomes of the same attempt and cannot both hold.
 */
export function sessionBanner(
  grant: { status: string; detail?: string } | null,
  dismissed: boolean,
): SessionBanner {
  if (dismissed || grant === null) return { kind: 'none' }
  if (grant.status === 'identity-mismatch') return { kind: 'identity-mismatch' }
  if (grant.status === 'error') return { kind: 'pairing-error', detail: grant.detail ?? '' }
  return { kind: 'none' }
}

/**
 * The document this browser's own keeper should open for an address, or
 * `undefined` for anything else.
 *
 * ONE route grammar means a daemon address parses under the browser keeper
 * too, naming a workspace this keeper does not have — reachable by hand, and
 * reached for real by the 'Work in this browser instead' escape, which leaves
 * a `/w/<daemon-ws>/d/...` address behind as it switches keeper. Treating
 * that as a browser document would open a path in a workspace that does not
 * exist here; the index is the honest answer, and is what this shell already
 * showed while the two grammars kept them apart.
 *
 * Matched against BOTH identity layers rather than against the handle: the
 * canonical-id form is the durable link, and comparing to `segment ?? id`
 * rejects it the moment a segment exists.
 */
export function browserDocumentPath(route: WorkspaceRoute | null): string | undefined {
  if (route?.kind !== 'document') return undefined
  if (!browserWorkspaceMatches(route.workspace)) return undefined
  return route.path
}

/**
 * ADR-0023's offline read: the addressed workspace is daemon-kept, the daemon
 * answered the renewal with nothing usable, and this browser holds a replica
 * of it — so the session reads that replica instead of silently landing on
 * the browser's own workspaces.
 *
 * Looked up by EITHER identity layer: the registry keys by the canonical id
 * and captured the segment at sync time, because offline is exactly when a
 * segment cannot be resolved.
 */
export function replicaRead({
  renewal,
  daemonKept,
  route,
  settings,
}: {
  renewal: 'refused' | 'unreachable' | null
  daemonKept: boolean
  route: WorkspaceRoute | null
  settings: UserSettings
}): { match: ReplicaMatch; renewal: 'refused' | 'unreachable' } | null {
  if (renewal === null || daemonKept) return null
  if (route?.workspace === undefined) return null
  const match = findReplicaForHandle(settings, route.workspace)
  return match === null ? null : { match, renewal }
}

/**
 * A pairing link is still being turned into a connection — the silent renewal,
 * or the hop to the daemon's consent page about to happen.
 *
 * Rendering the browser's own workspaces during that window would flash the
 * WRONG keeper's documents for as long as it takes, and on the consent path
 * the user would watch them disappear again.
 *
 * Only while the outcome is still OPEN: an 'identity-mismatch' or 'error'
 * result is a RESOLUTION — it has its own banner on the browser screen, and
 * swallowing it here would leave the page reading "Connecting…" forever over a
 * daemon that had already failed its identity check.
 *
 * Answers the daemon's ADDRESS rather than a boolean, so the screen that
 * states what is being connected to cannot be reached without it.
 */
export function linkPairingPending({
  forcedBrowser,
  linkBaseUrl,
  grantPaired,
  grant,
}: {
  forcedBrowser: boolean
  linkBaseUrl: string | undefined
  grantPaired: boolean
  grant: { status: string } | null
}): string | null {
  if (forcedBrowser || linkBaseUrl === undefined || grantPaired) return null
  const open = grant === null || grant.status === 'none'
  return open ? linkBaseUrl : null
}
