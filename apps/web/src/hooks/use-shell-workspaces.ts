import type { RenameWorkspaceInput } from '@kamiazya/whiteboard-ports'
import { useMemo } from 'react'
import { type WorkspaceRoute, workspacePath } from '../lib/app-routes.js'
import type { KeeperWorkspaces } from '../lib/workspace-switcher-source.js'

/**
 * Both keepers' halves of the workspace switcher, built side by side.
 *
 * They answer ONE contract (`WorkspaceSwitcherSource`) from two entirely
 * different places, so the thing worth reading is how their answers differ
 * — and that is only readable when they sit together. Every reach into
 * either keeper is a dynamic import: the shell is lazy and `App` is not, so
 * a static one would put the browser's IndexedDB registry and the daemon's
 * HTTP client in the entry chunk for a control most sessions never open.
 *
 * The daemon's is absent when no daemon is being talked to; the browser's
 * always exists, because this browser always has a registry.
 */
export function useShellWorkspaces({
  daemonShellTarget,
  navigate,
  setDaemonRoute,
}: {
  readonly daemonShellTarget:
    | { readonly baseUrl: string; readonly token: string | undefined }
    | undefined
  readonly navigate: (to: string) => void
  /**
   * The daemon keeper's view setter. Taken rather than a ready-made
   * `onSwitch`, because the source below is memoized and read in an effect
   * keyed on it: a callback rebuilt per render would be a workspace list
   * fetched per render. A `useState` setter is stable by contract; an inline
   * arrow at the call site would not be.
   */
  readonly setDaemonRoute: (route: WorkspaceRoute) => void
}): {
  readonly daemonWorkspaces: KeeperWorkspaces | undefined
  readonly browserWorkspaces: KeeperWorkspaces
} {
  // Creation and renaming are offered now that the daemon publishes a write
  // surface for workspaces. DESIGN.md's standing rule is what decided that
  // both ways round: they were ABSENT — not disabled — while the keeper
  // could not honour them, and they appear the moment it can.
  //
  // Switching is an in-app navigation, unlike the browser's: this keeper has
  // no synchronous singleton to re-point, so setting the view is enough. The
  // address follows from it, and the index page follows the address.
  const daemonWorkspaces = useMemo(
    (): KeeperWorkspaces | undefined =>
      daemonShellTarget === undefined
        ? undefined
        : {
            source: {
              list: () =>
                import('../lib/daemon-api-client.js').then((m) =>
                  m
                    .listWorkspaces(
                      m.createDaemonFetch(daemonShellTarget.baseUrl, daemonShellTarget.token),
                      daemonShellTarget.baseUrl,
                    )
                    .then((res) => res.workspaces),
                ),
              // Both halves take the same arguments as the browser's, which
              // is the point: the switcher asks its source, and the source is
              // the only thing that knows which keeper answered.
              create: (displayName: string) =>
                import('../lib/daemon-api-client.js').then((m) =>
                  m.createWorkspace(
                    m.createDaemonFetch(daemonShellTarget.baseUrl, daemonShellTarget.token),
                    daemonShellTarget.baseUrl,
                    displayName,
                  ),
                ),
              rename: (workspaceId: string, input: Omit<RenameWorkspaceInput, 'workspaceId'>) =>
                import('../lib/daemon-api-client.js').then((m) =>
                  m.renameWorkspace(
                    m.createDaemonFetch(daemonShellTarget.baseUrl, daemonShellTarget.token),
                    daemonShellTarget.baseUrl,
                    workspaceId,
                    input,
                  ),
                ),
            },
            onSwitch: (workspace: string) => setDaemonRoute({ kind: 'index', workspace }),
          },
    [daemonShellTarget, setDaemonRoute],
  )

  // Nothing here re-points the keeper, and that is the whole reason a switch
  // goes through the address: this one resolves its active workspace once,
  // into a synchronous accessor that some twenty call sites read inline, so
  // re-pointing it in place would mean re-reading it at every one of them.
  const browserWorkspaces = useMemo(
    (): KeeperWorkspaces => ({
      source: {
        list: () => import('../lib/browser-workspaces.js').then((m) => m.listBrowserWorkspaces()),
        // A SEPARATE module from the three below, and the separation is the
        // point: this is the only one that reads the workspace tree, so it is
        // the only one that pulls loro-crdt's WASM. The switcher asks for it
        // when its popover opens, never on the shell's render path.
        counts: () =>
          import('../lib/browser-document-counts.js').then((m) => m.browserDocumentCounts()),
        create: (displayName: string) =>
          import('../lib/browser-workspaces.js').then((m) =>
            m.createBrowserWorkspaceNamed(displayName),
          ),
        rename: (workspaceId: string, input: Omit<RenameWorkspaceInput, 'workspaceId'>) =>
          import('../lib/browser-workspaces.js').then((m) =>
            m.renameBrowserWorkspace(workspaceId, input),
          ),
      },
      // An in-SPA route change (ADR-0019), not a document load. The address
      // moves first and the identity follows it, which is the same direction
      // everything else in this app reads: the address sync re-points the
      // active workspace to whatever the address names, and rewrites the
      // address only when it names nothing this browser holds.
      onSwitch: (handle: string) => {
        navigate(workspacePath(handle))
      },
    }),
    [navigate],
  )

  return { daemonWorkspaces, browserWorkspaces }
}
