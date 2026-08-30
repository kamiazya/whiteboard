import { Settings } from 'lucide-react'
import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useSettingsNudge } from '@/hooks/useSettingsNudge'
import { parseWorkspaceRoute, settingsPath } from '@/lib/app-routes'
import { beginPairingGrant } from '@/lib/pairing-grant'
import { getShellConnection, subscribeShellStatus } from '@/lib/shell-status-store'
import { createUserSettingsStore } from '@/lib/user-settings-store'
import { workspaceHandle, workspaceLabel } from '@/lib/workspace-handle'
import { ConnectionStatus, connectionLabel, isSyncOff } from './connection/ConnectionStatus.js'
import {
  WorkspaceMenu,
  type WorkspaceRow,
  type WorkspaceSwitcherSource,
} from './shell/WorkspaceMenu.js'

// React.lazy for the same reason the browser page had it: the banner
// pulls in daemon-probe.ts and its Zod parsing, and only the Local popover
// ever opens it.
const DaemonDetectedBanner = lazy(() =>
  import('./migration/DaemonDetectedBanner.js').then((m) => ({
    default: m.DaemonDetectedBanner,
  })),
)

/**
 * The honest-detach floor for a moved workspace: a cold load whose silent
 * daemon renewal fails lands in the browser flow with the stored daemon
 * still configured. For a workspace that was MOVED to that daemon, resuming
 * browser keeper duties silently would hide that edits made here diverge
 * from the daemon copy — so the browser popover discloses the move. Only
 * when the recorded move targets the SAME daemon the browser still points
 * at: a move to a daemon this browser no longer uses is not this
 * connection's story. Reachability is unknown from here and deliberately
 * not claimed.
 */
function PromotedElsewhereNotice({
  settingsStore,
}: {
  settingsStore: ReturnType<typeof createUserSettingsStore>
}) {
  const settings = settingsStore.load()
  const promotion = settings.migration.promotion
  const storedDaemon = settings.storage.daemonBaseUrl
  if (
    promotion === undefined ||
    !promotion.ok ||
    storedDaemon === undefined ||
    promotion.daemonBaseUrl !== storedDaemon
  ) {
    return null
  }
  return (
    <p data-testid="promoted-elsewhere-notice" className="text-muted-foreground">
      This workspace has been moved to the daemon at{' '}
      <span className="font-mono text-xs">{storedDaemon.replace(/^https?:\/\//, '')}</span>. Changes
      made here stay in this browser until you move it again from Settings.
    </p>
  )
}

export interface AppShellProps {
  readonly daemon: boolean
  /**
   * Switches the app to the browser flow. The App branch owns this, so
   * a branch without the escape (settings, the browser flow itself) leaves it
   * unset and the chip drops the two actions that depend on it.
   */
  readonly onWorkInBrowser?: () => void
  /**
   * The keeper's half of the workspace switcher — where its workspaces come
   * from and what a switch means for it. Absent on a branch that has no
   * workspace to name (the invalid-config and pairing-error screens), and the
   * shell then states no subject rather than an empty one.
   *
   * Passed in rather than built here: the two keepers read their registries
   * from entirely different places, and a shell that knew both would import
   * the browser's IndexedDB index and the daemon's HTTP client into every
   * page's chrome.
   */
  readonly workspaces?: AppShellWorkspaces
}

/** The keeper's half of the switcher, named so a composition root can hold one. */
export interface AppShellWorkspaces {
  readonly source: WorkspaceSwitcherSource
  readonly onSwitch: (handle: string) => void
}

/**
 * The app-level chrome, deliberately minimal: the signature mark and the
 * alpha honesty chip on the left, the settings gear (+ attention dot) on the
 * right. Nothing else ever moves in here — context and tools stay in the
 * page's own surface, always visible (see DESIGN.md's shell rule). Pages
 * mount this shared component instead of owning any brand, connection or
 * settings chrome themselves.
 *
 * The mark is the row's SUBJECT and its one state carrier. Left of the
 * spacer is "what you are working in"; right of it is the app and its own
 * state. There is no connection chip any more — a workspace's keeper and its
 * session are things about the workspace, so they belong on the thing that
 * names it rather than on a second widget at the other end of the row.
 */
export function AppShell({ daemon, onWorkInBrowser, workspaces }: AppShellProps) {
  const navigate = useNavigate()
  const location = useLocation()
  // Read fresh rather than cached in state: the store is a thin localStorage
  // accessor, and a cached snapshot would go stale behind the settings page.
  const [settingsStore] = useState(() => createUserSettingsStore())
  // Published by whichever page holds a live document session; `null` on an
  // index or settings page, which has none to describe.
  const connection = useSyncExternalStore(subscribeShellStatus, getShellConnection)
  // Sync off means the daemon rejected the session and re-pairing is the only
  // way out, so it counts as disconnected for the attention dot. A transient
  // reconnect does not — it recovers on its own.
  const nudge = useSettingsNudge(daemon && !(connection !== null && isSyncOff(connection.state)))
  const daemonBaseUrl = connection?.daemonBaseUrl
  // The rows live HERE rather than in the menu, because the popover's head
  // names the current workspace and the head is the shell's. One fetch, two
  // readers.
  const [rows, setRows] = useState<readonly WorkspaceRow[]>([])
  const source = workspaces?.source
  useEffect(() => {
    if (source === undefined) return
    let cancelled = false
    source
      .list()
      .then((loaded) => {
        if (!cancelled) setRows(loaded)
      })
      // A list that will not load leaves the mark naming the handle the
      // address carries, which is still true. Failing the whole shell over
      // it would take the settings gear down with it.
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [source])
  const workspaceHandleInAddress = parseWorkspaceRoute(location.pathname)?.workspace ?? null
  // The handle until the row lands: a true statement about where you are,
  // and better than a blank in an accessible name.
  const activeName =
    workspaceHandleInAddress === null
      ? undefined
      : (() => {
          const row = rows.find((w) => workspaceHandle(w) === workspaceHandleInAddress)
          return row === undefined ? workspaceHandleInAddress : workspaceLabel(row)
        })()

  return (
    <header className="flex h-10 shrink-0 items-center gap-2 border-b bg-background px-3">
      {/* ONE carrier, and one trigger. The mark IS the switcher ("Mark as
          Switcher"): it names the workspace in its accessible name, opens the
          popover that lists the others, and carries the session state when a
          page published one. It opens on every page — the workspace is a fact
          everywhere, so there is always something for the popover to say —
          which is why the plain-link-home shape is gone. It gained no
          replacement destination: a whole-account view of every document is a
          state this product does not have, and leaving a document is the
          page's own affordance. */}
      <ConnectionStatus
        state={connection?.state ?? null}
        daemonBaseUrl={daemonBaseUrl}
        {...(activeName === undefined ? {} : { workspaceName: activeName })}
        workspaceMenu={
          // Rendered whenever a keeper published a switcher, INCLUDING when
          // the address names no workspace. A daemon holding nothing serves
          // `/`, and this menu is the only place creation is offered — so
          // requiring a handle here left a fresh daemon with no way to make
          // its first workspace, which is the one thing this increment set out
          // to make possible. With no handle the menu simply has no current
          // row: the rename section is already behind `active !== undefined`,
          // so it degrades to a list and a create button on its own.
          workspaces ? (
            <WorkspaceMenu
              current={workspaceHandleInAddress}
              workspaces={rows}
              source={workspaces.source}
              onSwitch={workspaces.onSwitch}
              sessionLabel={connectionLabel(connection?.state ?? null)}
              // MERGED, not replaced. A rename answers with a WorkspaceEntry —
              // the three identity layers and nothing else — while the row it
              // lands on is a WorkspaceRow that also carries what the keeper
              // counted. Replacing dropped that count until something else
              // reloaded the list.
              onRenamed={(entry) =>
                setRows((current) =>
                  current.map((row) =>
                    row.workspaceId === entry.workspaceId ? { ...row, ...entry } : row,
                  ),
                )
              }
            />
          ) : undefined
        }
        onRepair={
          daemonBaseUrl === undefined
            ? undefined
            : () => {
                void beginPairingGrant({
                  daemonBaseUrl,
                  hostedOrigin: window.location.origin,
                  sessionStorage: window.sessionStorage,
                  navigate: (url) => window.location.assign(url),
                })
              }
        }
        onWorkInBrowser={onWorkInBrowser}
      >
        {connection?.state.keeper === 'browser' && (
          <>
            <p className="text-muted-foreground">
              Connect a daemon (MCP) for version history, variations and merging. Once connected,
              you can move this workspace to it from Settings — documents, their history and images
              together.
            </p>
            <PromotedElsewhereNotice settingsStore={settingsStore} />
            <Suspense fallback={null}>
              <DaemonDetectedBanner
                settingsStore={settingsStore}
                fetch={window.fetch.bind(window)}
              />
            </Suspense>
          </>
        )}
      </ConnectionStatus>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Alpha preview notes"
            className="shrink-0 rounded-full border border-amber-600/55 px-1.5 font-mono text-[10px] leading-4 tracking-wide text-amber-600 hover:bg-amber-600/10 dark:border-amber-500/55 dark:text-amber-500"
          >
            ALPHA
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 text-sm">
          <p className="font-medium">Alpha preview</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Data durability is not guaranteed yet. Browser storage can be evicted by the device —
            export what matters, or protect it with persistent storage and a daemon.
          </p>
          <Link
            to={settingsPath('data')}
            className="mt-2 inline-block text-xs font-semibold text-primary hover:underline"
          >
            Protect your data
          </Link>
        </PopoverContent>
      </Popover>
      <span className="min-w-0 flex-1" />
      <button
        type="button"
        // The dot is the only thing on the shell that can read as an alarm.
        // Naming its cause turns it from "did I break something?" into a
        // task the user can choose to do.
        aria-label={nudge ? 'Settings — a setup step is waiting' : 'Settings'}
        title={nudge ? 'Settings — a setup step is waiting' : 'Settings'}
        data-testid="shell-settings"
        onClick={() =>
          navigate(settingsPath(), {
            state: { from: `${location.pathname}${location.search}` },
          })
        }
        className="relative shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        {nudge && (
          <span
            data-testid="settings-nudge"
            aria-hidden="true"
            className="absolute right-0.5 top-0.5 size-2 rounded-full bg-[#3b6ecc] ring-2 ring-background"
          />
        )}
        <Settings className="size-4" />
      </button>
    </header>
  )
}
