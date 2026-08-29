import { Settings } from 'lucide-react'
import { lazy, Suspense, useState, useSyncExternalStore } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useSettingsNudge } from '@/hooks/useSettingsNudge'
import { parseWorkspaceRoute, settingsPath } from '@/lib/app-routes'
import { beginPairingGrant } from '@/lib/pairing-grant'
import { getShellConnection, subscribeShellStatus } from '@/lib/shell-status-store'
import { createUserSettingsStore } from '@/lib/user-settings-store'
import { ConnectionStatus, isSyncOff } from './connection/ConnectionStatus.js'
import { ShellMark } from './shell/ShellMark.js'
import { WorkspaceSwitcher, type WorkspaceSwitcherSource } from './shell/WorkspaceSwitcher.js'

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
  readonly workspaces?: {
    readonly source: WorkspaceSwitcherSource
    readonly onSwitch: (handle: string) => void
  }
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

  return (
    <header className="flex h-10 shrink-0 items-center gap-2 border-b bg-background px-3">
      {connection ? (
        // The ONE connection affordance: the mark signals the state and its
        // popover carries the explanation and every recovery path. Re-pairing
        // navigates top-level to the daemon's own /pair consent page, the
        // same trust anchor first-time pairing uses.
        <ConnectionStatus
          state={connection.state}
          daemonBaseUrl={daemonBaseUrl}
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
          {connection.state.keeper === 'browser' && (
            <>
              <p className="text-muted-foreground">
                Connect a daemon (MCP) for version history, workspaces, variations and merging. Once
                connected, you can move this workspace to it from Settings — documents, their
                history and images together.
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
      ) : (
        // No page holds a live session, so there is no state to carry and
        // nothing for a popover to say. The mark is then what it has always
        // been — the way home — rather than a menu with one item in it.
        <Link
          to="/"
          aria-label="Home"
          className="shrink-0 rounded-md p-1 text-foreground/70 hover:bg-accent hover:text-foreground"
        >
          <ShellMark />
        </Link>
      )}
      {workspaces && (
        // The row's subject, right after the mark that carries its state.
        // The workspace is the outermost layer of `/w/:workspace/d/:path`,
        // so the address is where it is read from — the shell states what the
        // URL says, and never a second opinion about it.
        <WorkspaceSwitcher
          current={parseWorkspaceRoute(location.pathname)?.workspace ?? null}
          source={workspaces.source}
          onSwitch={workspaces.onSwitch}
        />
      )}
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
