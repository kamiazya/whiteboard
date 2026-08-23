import { Settings } from 'lucide-react'
import { lazy, Suspense, useState, useSyncExternalStore } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useSettingsNudge } from '@/hooks/useSettingsNudge'
import { settingsPath } from '@/lib/app-routes'
import { beginPairingGrant } from '@/lib/pairing-grant'
import { getShellConnection, subscribeShellStatus } from '@/lib/shell-status-store'
import { createUserSettingsStore } from '@/lib/user-settings-store'
import HomeMark from '../brand/home-mark.svg?react'
import { ConnectionStatus } from './connection/ConnectionStatus.js'

// React.lazy for the same reason the browser-local page had it: the banner
// pulls in daemon-probe.ts and its Zod parsing, and only the Local popover
// ever opens it.
const DaemonDetectedBanner = lazy(() =>
  import('./migration/DaemonDetectedBanner.js').then((m) => ({
    default: m.DaemonDetectedBanner,
  })),
)

export interface AppShellProps {
  readonly daemon: boolean
  /**
   * Switches the app to the browser-local flow. The App branch owns this, so
   * a branch without the escape (settings, browser-local itself) leaves it
   * unset and the chip drops the two actions that depend on it.
   */
  readonly onWorkInBrowser?: () => void
}

/**
 * The app-level chrome, deliberately minimal: brand (= go home) + the alpha
 * honesty chip on the left, the connection chip and the settings gear (+
 * attention dot) on the right. Nothing else ever moves in here — context and
 * tools stay in the page's own surface, always visible (see DESIGN.md's shell
 * rule). Pages mount this shared component instead of owning any brand,
 * connection or settings chrome themselves.
 */
export function AppShell({ daemon, onWorkInBrowser }: AppShellProps) {
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
  const nudge = useSettingsNudge(daemon && connection?.state !== 'sync-off')
  const daemonBaseUrl = connection?.daemonBaseUrl

  return (
    <header className="flex h-10 shrink-0 items-center gap-2 border-b bg-background px-3">
      <Link
        to="/"
        aria-label="Home"
        className="shrink-0 rounded-md p-1 text-foreground/70 hover:bg-accent hover:text-foreground"
      >
        <HomeMark className="h-[16px] w-[26px]" />
      </Link>
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
      {connection && (
        // The ONE connection affordance: the chip signals the state and its
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
          onDisconnect={
            onWorkInBrowser === undefined || daemonBaseUrl === undefined
              ? undefined
              : () => {
                  // Recorded so discovery skips it next time: the default port
                  // range is rescanned on every visit, so forgetting alone
                  // would bring this daemon straight back and make the action
                  // look like a no-op.
                  settingsStore.update((current) => {
                    const known = (current.storage.knownDaemonBaseUrls ?? []).filter(
                      (entry) => entry !== daemonBaseUrl,
                    )
                    const dismissed = (current.storage.dismissedDaemonBaseUrls ?? []).filter(
                      (entry) => entry !== daemonBaseUrl,
                    )
                    // Clearing the stored target is what makes this outlive
                    // the page: App.tsx reads localDaemonBaseUrl to decide a
                    // load is daemon-backed, so leaving it set reconnects on
                    // the next visit and the popover's "this browser stops
                    // using it" becomes false.
                    const { localDaemonBaseUrl, ...storage } = current.storage
                    return {
                      ...current,
                      storage: {
                        ...storage,
                        ...(localDaemonBaseUrl === daemonBaseUrl ? {} : { localDaemonBaseUrl }),
                        knownDaemonBaseUrls: known,
                        dismissedDaemonBaseUrls: [daemonBaseUrl, ...dismissed].slice(0, 5),
                      },
                    }
                  })
                  onWorkInBrowser()
                }
          }
        >
          {connection.state === 'browser' && (
            <>
              <p className="text-muted-foreground">
                Connect a daemon (MCP) for version history, workspaces, variations and merging.
                Documents already in this browser stay here — import them one at a time.
              </p>
              <Suspense fallback={null}>
                <DaemonDetectedBanner
                  settingsStore={settingsStore}
                  fetch={window.fetch.bind(window)}
                />
              </Suspense>
            </>
          )}
        </ConnectionStatus>
      )}
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
