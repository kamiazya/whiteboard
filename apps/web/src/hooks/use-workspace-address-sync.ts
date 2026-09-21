// Who owns the ADDRESS.
//
// Three effects and the refs they share. They were spread through `App`'s
// body over three hundred lines of other subjects, and they only make sense
// read together: the address follows the view, the browser keeper's half of
// the same rule, and the URL driving the state back when someone uses the
// back button.
//
// Their ORDER is load-bearing, which is the other reason they belong in one
// file. React flushes them in ONE commit, in the order they are registered
// here, whenever a stray address rewrite lands — and the state->URL effect
// stamping `lastRouteSyncPathRef` before it navigates is what stops the
// URL->state effect, reading the same stale pathname a moment later in that
// same flush, from parsing it back and starting the two of them overwriting
// each other forever (the request storm #1721 measured at ~500 req/s).
// `use-workspace-address-sync.ordering.test.ts` pins those source positions
// and reads THIS file.
//
// It answers with nothing: every line here is an effect or a ref one of
// them keeps.

import type { Dispatch, SetStateAction } from 'react'
import { useEffect, useRef } from 'react'
import {
  isKnownAppPath,
  parseSettingsRoute,
  parseWorkspaceRoute,
  type WorkspaceRoute,
  workspacePath,
  workspaceRoutePath,
} from '../lib/app-routes.js'
import { browserWorkspaceMatches, switchBrowserWorkspace } from '../lib/browser-workspace-id.js'
import { findReplicaForHandle } from '../lib/replicas.js'
import type { createUserSettingsStore } from '../lib/user-settings-store.js'

export interface WorkspaceAddressInputs {
  readonly location: ReturnType<typeof import('react-router-dom').useLocation>
  readonly navigate: ReturnType<typeof import('react-router-dom').useNavigate>
  readonly isPairRoute: boolean
  readonly browserHandle: string | null
  readonly daemonKept: boolean
  readonly daemonView: WorkspaceRoute
  readonly setDaemonView: Dispatch<SetStateAction<WorkspaceRoute>>
  readonly userSettingsStore: ReturnType<typeof createUserSettingsStore>
  /**
   * A stored daemon connection's silent renewal (App's `attemptRenewal`) is
   * a real network round trip, and `daemonKept` can only turn true once it
   * lands — so for as long as this is true, an address that does not (yet)
   * match the browser's OWN workspace is UNDECIDED, not foreign. Without
   * this, the browser-keeper rewrite below ran first, concluded a daemon
   * deep link belonged to nobody it knew, and rewrote it to the browser's
   * index before the renewal ever got to prove otherwise — losing the
   * link for good, since the URL -> state effect then read the rewritten
   * address back into `daemonView`.
   */
  readonly awaitingDaemonRenewal: boolean
}

export function useWorkspaceAddressSync(inputs: WorkspaceAddressInputs): void {
  const {
    location,
    navigate,
    isPairRoute,
    browserHandle,
    daemonKept,
    daemonView,
    setDaemonView,
    userSettingsStore,
    awaitingDaemonRenewal,
  } = inputs

  // The browser-keeper rewrite effect (below) reads this INSIDE an async
  // callback rather than through its own effect closure — a ref kept
  // current every render, not the value `daemonKept` held when the effect
  // last ran. `switchBrowserWorkspace`'s rejection for an unrecognized
  // (daemon) handle settles fast enough that it used to land AFTER a
  // same-tick pairing renewal had already committed `daemonKept: true`
  // (this ref) but BEFORE that render's effect cleanup had torn down the
  // in-flight async call (the effect's own `cancelled` flag) — so the
  // rewrite fired anyway, using a browserHandle/navigate that were still
  // perfectly valid, just answering a question the app had already moved
  // past. See that effect's comment for the storm this produced.
  const daemonKeptRef = useRef(daemonKept)
  daemonKeptRef.current = daemonKept

  const isFirstUrlSyncRef = useRef(true)
  // The path this effect last navigated to. StrictMode's effect replay
  // re-runs the effect with the PRE-navigation location still in its
  // closure, so without this the replay pushes a duplicate history entry
  // for the navigation the first run already performed.
  const lastNavigatedPathRef = useRef<string | null>(null)
  // Shared with the URL -> state effect below (hoisted here, ahead of it,
  // for exactly that reason). Declared in THIS component, so React flushes
  // both effects in ONE commit whenever they both have a reason to run —
  // and per React's own ordering, this one (declared first) runs before
  // that one. That ordering is what a navigate() below can lean on: marking
  // the pathname this effect is about to supersede as "already synced"
  // stops the URL -> state effect, reading the SAME stale `location.pathname`
  // a moment later in the same flush, from parsing it back into `daemonView`
  // — which is what turned a single stale address (a browser-keeper rewrite
  // that raced a still-resolving pairing renewal) into the two effects
  // alternately overwriting each other's fix, forever: each one's own
  // "did I already handle this path" ref never caught it, because the
  // address ping-ponged between exactly two values and neither effect saw
  // the pathname it had just itself produced land on ITS side of the check
  // before the other effect read it. Measured as ~500 req/s of
  // /api/workspaces + document-tags with the daemon page never settling.
  const lastRouteSyncPathRef = useRef(location.pathname)
  useEffect(() => {
    if (isPairRoute) return
    // A browser-kept session's address is not daemonView's to write —
    // rewriting it would yank an open browser-kept editor back to the list.
    if (!daemonKept) return
    // /settings is its own top-level surface, not a daemonView — without
    // this the sync effect below would immediately rewrite it to '/'.
    if (parseSettingsRoute(location.pathname) !== null) return
    // An unknown path is the not-found page's to keep: rewriting it to the
    // daemon route would swallow the 404 into a silent redirect.
    if (!isKnownAppPath(location.pathname)) return
    const path = workspaceRoutePath(daemonView)
    // Read-then-clear on the FIRST EFFECT RUN regardless of whether it ends
    // up navigating: a no-op first run (URL already matches the initial
    // view) must not leave the very next real navigation still thinking
    // it's the first one and wrongly replacing instead of pushing.
    const isFirstSync = isFirstUrlSyncRef.current
    isFirstUrlSyncRef.current = false
    if (location.pathname === path) {
      lastNavigatedPathRef.current = null
      return
    }
    if (lastNavigatedPathRef.current === path) return
    lastNavigatedPathRef.current = path
    // Naming an address that named nothing is a REPLACE. `/` does not say
    // which workspace is on screen; the page resolves one and this writes it
    // down, which is the app finishing a sentence rather than a step the
    // person took. Pushed, it would put `/` behind them — and going back
    // there resolves again and pushes again, a trap of our own making.
    // Changing a workspace the address already named is a real step and
    // pushes, so back returns to the one before.
    //
    // Narrow to index -> index deliberately. Opening a DOCUMENT from `/` also
    // leaves an address that named no workspace, and it is a step: replacing
    // there costs the back button the list you came from.
    const currentRoute = parseWorkspaceRoute(location.pathname)
    const namingTheSameIndex =
      daemonView.kind === 'index' &&
      currentRoute?.kind === 'index' &&
      currentRoute.workspace === undefined
    // Mark the pathname THIS navigate is about to replace as already
    // synced, before the URL -> state effect (same commit, runs after this
    // one) can read it back into `daemonView` — see `lastRouteSyncPathRef`'s
    // comment above.
    lastRouteSyncPathRef.current = location.pathname
    navigate(path, { replace: isFirstSync || namingTheSameIndex })
    // location.pathname is read, not depended on: including it would refire
    // this effect on every navigation (including the one it just performed),
    // which is harmless but noisy. daemonView is the actual trigger.
  }, [daemonView, navigate, isPairRoute, daemonKept])

  // The browser keeper's half of the same rule, and it exists for the same
  // reason the daemon's does: the address has to NAME the workspace on
  // screen. It went unwritten while this keeper held exactly one workspace,
  // where `/` and `/w/default` were the same statement in practice. They are
  // not once a workspace can be switched — the switcher changes the outermost
  // address layer, and `/` has no layer to change — and they were never the
  // same to `boot.ts`, which resolves the active workspace from
  // `parseWorkspaceRoute(location.pathname)?.workspace`: at `/` that is
  // always undefined, so a reload took first-listed no matter where the
  // person was.
  //
  // Two addresses get rewritten, and the second is not hypothetical. "Work in
  // this browser instead" switches keeper under a `/w/<daemon-workspace>/...`
  // address; the page already falls back to the index for it, but the address
  // kept naming a workspace this browser does not keep.
  //
  // REPLACE, like the daemon's: the app is finishing a sentence the person
  // started. Pushed, back would return to an address that rewrites itself
  // again — a trap of our own making.
  useEffect(() => {
    if (isPairRoute) return
    if (daemonKept) return
    // A stored daemon connection's silent renewal has not settled — see
    // this field's own comment. Until it does, this address is undecided,
    // not foreign: deciding now is exactly the race that used to rewrite a
    // daemon deep link out from under the renewal that would have claimed it.
    if (awaitingDaemonRenewal) return
    if (browserHandle === null) return
    if (parseSettingsRoute(location.pathname) !== null) return
    if (!isKnownAppPath(location.pathname)) return
    const route = parseWorkspaceRoute(location.pathname)
    const named = route === null ? undefined : route.workspace
    if (named !== undefined && browserWorkspaceMatches(named)) return
    // A replica address is not this keeper's to erase: the workspace it
    // names exists, kept elsewhere, and the replica page may be serving it.
    if (named !== undefined && findReplicaForHandle(userSettingsStore.load(), named) !== null)
      return
    let cancelled = false
    const rewrite = () => {
      if (cancelled) return
      // Re-checked live (see `daemonKeptRef`'s comment): this effect's OWN
      // `daemonKept` closure is whatever it was when the effect last ran,
      // which for an address that just turned daemon-kept is stale by the
      // time an async resolve/reject actually reaches here — the pairing
      // renewal driving `daemonKept` true is a real network round trip, so
      // it regularly loses the race against this rejection, but its state
      // update still lands (and this ref updates) before this callback
      // fires. Skipping stops the rewrite from ever reaching a now-daemon-
      // kept address — the ping-pong this produced never gets a first move.
      if (daemonKeptRef.current) return
      const path = workspacePath(browserHandle)
      if (location.pathname !== path) navigate(path, { replace: true })
    }
    // An address naming a workspace this browser DOES hold is a switch, not a
    // mistake — the switcher moves the address and this is what makes the
    // runtime follow. Only a handle the registry cannot resolve gets the
    // address rewritten, and `switchBrowserWorkspace` is strict precisely so
    // the two cases stay distinguishable here: a lenient resolve would answer
    // every unknown handle with first-listed, and this effect would then
    // rewrite the address to a workspace nobody asked for while believing it
    // had switched.
    if (named === undefined) {
      rewrite()
    } else {
      switchBrowserWorkspace(named).then((moved) => {
        if (moved === null) rewrite()
      }, rewrite)
    }
    return () => {
      cancelled = true
    }
  }, [location.pathname, browserHandle, daemonKept, isPairRoute, navigate, awaitingDaemonRenewal])

  // URL -> state: handles the browser back/forward buttons (and, in
  // principle, any other code path that changes the route without going
  // through setDaemonView).
  // Guarded by pathname VALUE, not a first-run flag: StrictMode's effect
  // replay re-runs this effect with the pre-navigation pathname still in
  // its closure, and a run-count flag let that replay read the stale '/'
  // as user intent — overwriting the #wb= payload-derived canvas view with
  // the gallery and, in a live browser, seeding a perpetual navigation
  // ping-pong that remounted the canvas page (and its WebSocket) ~170
  // times a second. Only an actual pathname CHANGE is a URL-driven
  // navigation; the ref seeds from the mount pathname so the mount run and
  // any replay of it are no-ops. `lastRouteSyncPathRef` itself is declared
  // above, beside the state->URL effect — see its comment.
  useEffect(() => {
    if (isPairRoute) return
    if (lastRouteSyncPathRef.current === location.pathname) return
    lastRouteSyncPathRef.current = location.pathname
    const parsed = parseWorkspaceRoute(location.pathname)
    if (parsed === null) return
    // parseDaemonRoute returns a fresh object every time, and React compares
    // state by reference — so re-set only when the route actually differs,
    // otherwise a back/forward landing on the current view re-renders for
    // nothing.
    setDaemonView((current: WorkspaceRoute) =>
      workspaceRoutePath(current) === workspaceRoutePath(parsed) ? current : parsed,
    )
  }, [location.pathname, isPairRoute])
}
