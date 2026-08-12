import { Settings } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useSettingsNudge } from '@/hooks/useSettingsNudge'
import { settingsPath } from '@/lib/app-routes'
import { getShellDaemonAuthError, subscribeShellStatus } from '@/lib/shell-status-store'
import HomeMark from '../brand/home-mark.svg?react'

/**
 * The app-level chrome, deliberately minimal: brand (= go home) + the alpha
 * honesty chip on the left, the settings gear (+ attention dot) on the
 * right. Nothing else ever moves in here — context and tools stay in the
 * page's own surface, always visible (see DESIGN.md's shell rule). Pages
 * mount this shared component instead of owning any brand/settings chrome
 * themselves.
 */
export function AppShell({ daemon }: { daemon: boolean }) {
  const navigate = useNavigate()
  const location = useLocation()
  // A live auth error (reported by DaemonCanvasPage through the shell-status
  // store) means the daemon needs the user's action, so it counts as
  // disconnected for the attention dot.
  const authError = useSyncExternalStore(subscribeShellStatus, getShellDaemonAuthError)
  const nudge = useSettingsNudge(daemon && !authError)

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
            export what matters, or protect it with persistent storage and a local daemon.
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
        aria-label="Settings"
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
