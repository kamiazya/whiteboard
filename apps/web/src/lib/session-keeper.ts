import type { WorkspaceRoute } from './app-routes.js'
import { browserWorkspaceMatches } from './browser-workspace-id.js'
import type { ConnectedDaemon } from './daemon-auth-fetch.js'
import type { ProviderState } from './provider.js'
import { findReplicaForHandle, type ReplicaMatch } from './replicas.js'
import type { UserSettings } from './user-settings-store.js'

/**
 * WHO KEEPS this session's workspace, and how to reach them — the derivations
 * that would otherwise be four stacked ternaries among `App`'s thirty hooks.
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
 * mode the user explicitly opted out of, or bounce the escape
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
 * Decided by the reconnection and provider state — ADR-0004 settles it at
 * page load — and these are the same two conditions the render tail uses to
 * choose a daemon tree over the browser one. Derived rather than read off the
 * address: three-layer identity exists so the URL's own shape (`/local/*`)
 * does not decide this, and that shape could not survive the two route
 * families becoming one.
 */
export function daemonKeepsSession({
  forcedBrowser,
  connected,
  effectiveState,
}: {
  forcedBrowser: boolean
  connected: boolean
  effectiveState: ProviderState
}): boolean {
  if (effectiveState.kind === 'daemon') return true
  if (forcedBrowser) return false
  return connected
}

/**
 * Which daemon the SHELL is talking to: the one this page reconnected to
 * through the extension, or the configured provider state.
 *
 * `undefined` under the 'Work in this browser instead' escape, which opts out
 * of every daemon the session might otherwise have reached.
 */
export function shellDaemon({
  forcedBrowser,
  connection,
  effectiveState,
}: {
  forcedBrowser: boolean
  connection: { daemonBaseUrl: string } | null
  effectiveState: ProviderState
}): ConnectedDaemon | undefined {
  if (forcedBrowser) return undefined
  if (connection !== null) return { baseUrl: connection.daemonBaseUrl }
  if (effectiveState.kind === 'daemon') return { baseUrl: effectiveState.daemonBaseUrl }
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
  connection,
  providerState,
}: {
  forcedBrowser: boolean
  connection: { daemonBaseUrl: string } | null
  providerState: ProviderState
}): ConnectedDaemon | undefined {
  if (forcedBrowser) return undefined
  if (connection !== null) return { baseUrl: connection.daemonBaseUrl }
  if (providerState.kind === 'daemon') return { baseUrl: providerState.daemonBaseUrl }
  return undefined
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
 * did not answer the reconnection, and this browser holds a replica
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
  renewal: 'unreachable' | null
  daemonKept: boolean
  route: WorkspaceRoute | null
  settings: UserSettings
}): { match: ReplicaMatch; renewal: 'unreachable' } | null {
  if (renewal === null || daemonKept) return null
  if (route?.workspace === undefined) return null
  const match = findReplicaForHandle(settings, route.workspace)
  return match === null ? null : { match, renewal }
}

/**
 * A remembered daemon's reconnection is in flight and has not answered, so
 * which keeper holds this session is undecided — and the browser's own
 * workspace must not be rendered meanwhile. The two keepers can share a
 * workspace segment, so the address may name the daemon's document; a
 * browser page opened on it leads somewhere else before the reconnection
 * lands.
 */
export function renewalPending({
  forcedBrowser,
  awaitingDaemonRenewal,
  connected,
}: {
  forcedBrowser: boolean
  awaitingDaemonRenewal: boolean
  connected: boolean
}): boolean {
  return !forcedBrowser && awaitingDaemonRenewal && !connected
}
