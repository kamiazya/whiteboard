// Who owns the ADDRESS.
//
// Three effects that were spread through `App`'s body, and they only make
// sense read together: the address follows the view, the browser keeper's
// half of the same rule, and the URL driving the state back when someone
// uses the back button. Separated by three hundred lines of other subjects
// they read as three unrelated navigations; together they are one rule with
// three directions, and the refs that keep StrictMode's effect replay from
// pushing duplicate history entries belong to all of them.
//
// It answers with nothing: every line here is an effect.

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
  } = inputs

  const isFirstUrlSyncRef = useRef(true)
  // The path this effect last navigated to. StrictMode's effect replay
  // re-runs the effect with the PRE-navigation location still in its
  // closure, so without this the replay pushes a duplicate history entry
  // for the navigation the first run already performed.
  const lastNavigatedPathRef = useRef<string | null>(null)
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
  }, [location.pathname, browserHandle, daemonKept, isPairRoute, navigate])

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
  // any replay of it are no-ops.
  const lastRouteSyncPathRef = useRef(location.pathname)
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
    setDaemonView((current) =>
      workspaceRoutePath(current) === workspaceRoutePath(parsed) ? current : parsed,
    )
  }, [location.pathname, isPairRoute])
}
