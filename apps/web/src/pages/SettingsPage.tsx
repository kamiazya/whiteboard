import { storageReportPayloadSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import {
  Cable,
  ChevronLeft,
  ChevronRight,
  Database,
  Grid2x2,
  Monitor,
  Moon,
  Palette,
  Sun,
  Type,
  Waves,
  Wrench,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { FontsCard } from '../components/FontsCard.js'
import { PairedOriginsCard } from '../components/PairedOriginsCard.js'
import { StorageReportCard } from '../components/StorageReportCard.js'
import { AppVersionRow } from '../components/settings/AppVersionRow.js'
import { GestureTraceRow } from '../components/settings/GestureTraceRow.js'
import { PromoteWorkspaceSection } from '../components/settings/PromoteWorkspaceSection.js'
import type { PersistStepState } from '../components/settings/SetupJourney.js'
import { findVisibleJourneyBadge, SetupJourney } from '../components/settings/SetupJourney.js'
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip.js'
import { DaemonApiContext } from '../contexts/DaemonApiContext.js'
import { useThemeMode } from '../hooks/useThemeMode.js'
import { parseSettingsRoute, type SettingsSection, settingsPath } from '../lib/app-routes.js'
import { celebrate } from '../lib/celebrate.js'
import { createDaemonFetch } from '../lib/daemon-api-client.js'
import type { ConnectedDaemon } from '../lib/daemon-auth-fetch.js'
import { disconnectFromDaemon } from '../lib/disconnect-daemon.js'
import type { FaviconStyle } from '../lib/favicon.js'
import {
  getInstallState,
  promptInstall,
  subscribeInstallState,
} from '../lib/install-prompt-store.js'
import {
  type BrowserStorageEstimate,
  ensurePersistentStorage,
  queryPersistentStorage,
  queryStorageEstimate,
} from '../lib/persistent-storage.js'
import { createUserSettingsStore } from '../lib/user-settings-store.js'

export interface SettingsPageProps {
  daemon?: ConnectedDaemon
  /**
   * Called after this browser stops using the daemon, so the App branch can
   * follow the settings it just wrote. Without it the change only takes
   * effect on the next load, and the copy's "stops using it" reads as a
   * no-op for the rest of the session.
   */
  onDisconnected?: () => void
}

const THEME_OPTIONS: Array<{
  value: 'light' | 'dark' | 'system'
  label: string
  icon: typeof Sun
}> = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
]

const FAVICON_OPTIONS: Array<{ value: FaviconStyle; label: string; icon: typeof Sun }> = [
  { value: 'minimap', label: 'Minimap', icon: Grid2x2 },
  { value: 'dot', label: 'Dot only', icon: Waves },
]

const NAV_ITEMS: Array<{ section: SettingsSection; label: string; icon: typeof Palette }> = [
  { section: 'general', label: 'General', icon: Palette },
  { section: 'data', label: 'Data & app', icon: Database },
  { section: 'fonts', label: 'Fonts', icon: Type },
  { section: 'connections', label: 'Connections', icon: Cable },
  { section: 'developer', label: 'Developer', icon: Wrench },
]

const settingsStore = createUserSettingsStore()

interface GeneralSectionProps {
  theme: 'light' | 'dark' | 'system'
  onThemeChange: (next: 'light' | 'dark' | 'system') => void
  faviconStyle: FaviconStyle
  onFaviconStyleChange: (next: FaviconStyle) => void
  webMcpEnabled: boolean
  onWebMcpToggle: () => void
}

function GeneralSection({
  theme,
  onThemeChange,
  faviconStyle,
  onFaviconStyleChange,
  webMcpEnabled,
  onWebMcpToggle,
}: GeneralSectionProps) {
  const themeGroupId = useId()
  const faviconGroupId = useId()
  const webMcpLabelId = useId()
  const webMcpDescId = useId()
  return (
    <div className="space-y-6">
      <section aria-labelledby={themeGroupId}>
        <h2 id={themeGroupId} className="mb-3 flex items-center gap-2 text-sm font-medium">
          <Palette className="size-4" />
          Appearance
        </h2>
        <fieldset>
          <legend className="sr-only">Theme</legend>
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Theme">
            {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
              // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA button-as-radio pattern (icon + label styling not achievable with a native radio input)
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={theme === value}
                onClick={() => onThemeChange(value)}
                className={`flex flex-col items-center gap-1.5 rounded-md border px-3 py-2.5 text-xs transition-colors ${
                  theme === value
                    ? 'border-primary bg-primary/5 text-primary'
                    : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground'
                }`}
              >
                <Icon className="size-4" />
                {label}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset className="mt-4">
          <legend className="mb-2 text-xs text-muted-foreground">
            Tab icon — Minimap mirrors the canvas content; Dot only keeps the plain mark. Both carry
            the save/sync status dot.
          </legend>
          <div
            className="grid grid-cols-2 gap-2"
            role="radiogroup"
            aria-labelledby={faviconGroupId}
          >
            <span id={faviconGroupId} className="sr-only">
              Tab icon
            </span>
            {FAVICON_OPTIONS.map(({ value, label, icon: Icon }) => (
              // biome-ignore lint/a11y/useSemanticElements: same WAI-ARIA button-as-radio pattern as the theme picker above
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={faviconStyle === value}
                onClick={() => onFaviconStyleChange(value)}
                className={`flex flex-col items-center gap-1.5 rounded-md border px-3 py-2.5 text-xs transition-colors ${
                  faviconStyle === value
                    ? 'border-primary bg-primary/5 text-primary'
                    : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground'
                }`}
              >
                <Icon className="size-4" />
                {label}
              </button>
            ))}
          </div>
        </fieldset>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium">Capabilities</h2>
        <div className="flex items-center justify-between gap-3">
          <div>
            <p id={webMcpLabelId} className="text-sm">
              WebMCP
            </p>
            <p id={webMcpDescId} className="text-xs text-muted-foreground">
              Lets in-page scripts in supporting browsers read which keeper is active and which
              document is open (workspace and path, or document id). Never exposes content,
              selection, viewport, secrets, or tokens.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={webMcpEnabled}
            aria-labelledby={webMcpLabelId}
            aria-describedby={webMcpDescId}
            onClick={onWebMcpToggle}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors ${
              webMcpEnabled ? 'bg-primary' : 'bg-input'
            }`}
          >
            <span
              className={`pointer-events-none block size-4 rounded-full bg-background shadow-sm ring-0 transition-transform ${
                webMcpEnabled ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
      </section>
    </div>
  )
}

// Duplicate mount cost (this renders once per visible layout — mobile detail
// and desktop pane both exist in the DOM at once, see the module doc comment
// below) is an accepted tradeoff: PairedOriginsCard/StorageReportCard already
// own their fetch/error/loading state, and splitting that state out to share
// across two layouts would add real complexity for a cheap, idempotent GET.
function ConnectionsSection({
  daemon,
  onDisconnected,
}: {
  daemon?: ConnectedDaemon
  onDisconnected?: () => void
}) {
  // Keyed on the primitive fields, not `daemon` itself, so a re-render that
  // rebuilds the same `daemon` object (a new reference, same values) does not
  // rebuild this function — which would hand DaemonApiContext a new identity
  // and re-fire every consumer effect keyed on it (PairedOriginsCard's
  // load/fingerprint effects, StorageReportCard's fetch). Above the early
  // return so hook order stays unconditional across the connected/
  // disconnected branches; null-safe inside since `daemon` may be absent.
  const daemonFetch = useMemo(
    () => (daemon ? createDaemonFetch(daemon.baseUrl, daemon.token ?? undefined) : undefined),
    [daemon?.baseUrl, daemon?.token],
  )
  if (!daemon) {
    return (
      <div className="space-y-6">
        <section>
          <p className="text-sm">Daemon — Not connected</p>
          <p className="mt-1 text-xs text-muted-foreground">
            A daemon on this machine holds durable storage and the AI agent connection for this app.
          </p>
        </section>
        {/* Discoverable while disabled: the move exists before its
            precondition is met, so its condition can be read here. */}
        <PromoteWorkspaceSection settingsStore={settingsStore} />
      </div>
    )
  }
  return (
    <DaemonApiContext.Provider value={daemonFetch ?? null}>
      <div className="space-y-6">
        <section aria-label="Paired web apps">
          <PairedOriginsCard />
        </section>
        <section aria-label="Storage">
          <StorageReportCard />
        </section>
        <PromoteWorkspaceSection daemon={daemon} settingsStore={settingsStore} />
        {/* Management, not status: the chip reports which daemon keeps this
            workspace, and changing that is an intent you arrive here with. */}
        <section aria-label="This daemon" className="flex flex-col gap-1.5">
          <p className="text-sm">
            Connected to <span className="font-mono text-xs">{stripScheme(daemon.baseUrl)}</span>
          </p>
          <button
            type="button"
            data-testid="settings-disconnect"
            onClick={() => {
              disconnectFromDaemon(settingsStore, daemon.baseUrl)
              onDisconnected?.()
            }}
            className="self-start rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
          >
            Disconnect from this daemon
          </button>
          <p className="text-xs text-muted-foreground">
            This browser stops using it and stops looking for it. Your data stays on the daemon and
            is not deleted; pairing is not revoked.
          </p>
        </section>
      </div>
    </DaemonApiContext.Provider>
  )
}

function stripScheme(baseUrl: string): string {
  return baseUrl.replace(/^https?:\/\//, '')
}

/**
 * Fonts belong to the DAEMON, not to this browser: it is the daemon that
 * rasterises an export, so a font the browser alone has still exports as
 * tofu (ADR-0012 decision 4). Without one there is nothing to install into,
 * and saying so beats an empty list.
 */
function FontsSection({ daemon }: { daemon?: ConnectedDaemon }) {
  // See ConnectionsSection's daemonFetch comment: hoisted above the early
  // return, keyed on the primitive fields so an unrelated re-render does not
  // hand FontsCard's fetch-keyed effect a new identity to re-fire on.
  const daemonFetch = useMemo(
    () => (daemon ? createDaemonFetch(daemon.baseUrl, daemon.token ?? undefined) : undefined),
    [daemon?.baseUrl, daemon?.token],
  )
  if (!daemon) {
    return (
      <section>
        <p className="text-sm">Fonts — Not connected</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Installed fonts live on a local daemon, which renders exports. Connect one to choose fonts
          for the scripts you write in.
        </p>
      </section>
    )
  }
  return (
    <DaemonApiContext.Provider value={daemonFetch ?? null}>
      <section aria-label="Fonts">
        <FontsCard />
      </section>
    </DaemonApiContext.Provider>
  )
}

function sectionContent(
  section: SettingsSection,
  props: {
    theme: 'light' | 'dark' | 'system'
    onThemeChange: (next: 'light' | 'dark' | 'system') => void
    faviconStyle: FaviconStyle
    onFaviconStyleChange: (next: FaviconStyle) => void
    webMcpEnabled: boolean
    onWebMcpToggle: () => void
    persistStep: PersistStepState
    protecting: boolean
    protectDeclined: boolean
    onProtect: () => void
    installStatus: 'installed' | 'installable' | 'not-captured'
    estimate: BrowserStorageEstimate | null
    daemonStorageBytes: number | null
    daemon?: ConnectedDaemon
    onDisconnected?: () => void
  },
) {
  switch (section) {
    case 'general':
      return (
        <GeneralSection
          theme={props.theme}
          onThemeChange={props.onThemeChange}
          faviconStyle={props.faviconStyle}
          onFaviconStyleChange={props.onFaviconStyleChange}
          webMcpEnabled={props.webMcpEnabled}
          onWebMcpToggle={props.onWebMcpToggle}
        />
      )
    case 'data':
      return (
        <div>
          <SetupJourney
            persist={props.persistStep}
            protecting={props.protecting}
            protectDeclined={props.protectDeclined}
            onProtect={props.onProtect}
            install={props.installStatus}
            onInstall={() => void promptInstall()}
            daemonConnected={props.daemon !== undefined}
            estimate={props.estimate}
            daemonStorageBytes={props.daemonStorageBytes}
          />
          <div className="mt-6 border-t pt-4">
            <AppVersionRow />
          </div>
        </div>
      )
    case 'fonts':
      return <FontsSection daemon={props.daemon} />
    case 'connections':
      return <ConnectionsSection daemon={props.daemon} onDisconnected={props.onDisconnected} />
    case 'developer':
      return <GestureTraceRow />
  }
}

const SECTION_TITLE: Record<SettingsSection, string> = {
  general: 'General',
  data: 'Data & app',
  fonts: 'Fonts',
  connections: 'Connections',
  developer: 'Developer',
}

/**
 * Routed settings surface (theme, favicon style, WebMCP, storage, daemon
 * connections). Renders BOTH the mobile (section list / section detail) and desktop
 * (sidebar + content pane) layouts at once, switching which is visible via
 * `sm:` CSS classes rather than JS — this keeps the split unit-testable in
 * jsdom, which has no viewport to react to, at the cost of mounting the
 * current section's content twice while it's the active route (see
 * ConnectionsSection's fetch-cost note above).
 */
export function SettingsPage({ daemon, onDisconnected }: SettingsPageProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const parsed = parseSettingsRoute(location.pathname)
  const routeSection = parsed?.section ?? null
  // /settings (no section in the URL) is the mobile section list; desktop
  // has no "index" state of its own and always shows a section, so it
  // defaults to General.
  const desktopSection: SettingsSection = routeSection ?? 'general'

  const { theme, setTheme } = useThemeMode()
  const [faviconStyle, setFaviconStyle] = useState<FaviconStyle>(
    () => settingsStore.load().appearance?.faviconStyle ?? 'minimap',
  )
  const [webMcpEnabled, setWebMcpEnabled] = useState(
    () => settingsStore.load().capabilities.webMcpEnabled !== false,
  )
  const handleFaviconStyleChange = useCallback((next: FaviconStyle) => {
    setFaviconStyle(next)
    settingsStore.update((s) => ({ ...s, appearance: { ...s.appearance, faviconStyle: next } }))
  }, [])
  const handleWebMcpToggle = useCallback(() => {
    setWebMcpEnabled((current) => {
      const next = !current
      settingsStore.update((s) => ({
        ...s,
        capabilities: { ...s.capabilities, webMcpEnabled: next },
      }))
      return next
    })
  }, [])

  // null = API unavailable (Safari manages persistence itself). Queried once
  // on mount — there is no "open" event on a routed page the way there was
  // on the dialog.
  const [persisted, setPersisted] = useState<boolean | null>(null)
  const [persistedKnown, setPersistedKnown] = useState(false)
  useEffect(() => {
    let cancelled = false
    void queryPersistentStorage().then((state) => {
      if (cancelled) return
      setPersisted(state)
      setPersistedKnown(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const [protecting, setProtecting] = useState(false)
  const [protectDeclined, setProtectDeclined] = useState(false)
  const handleProtect = useCallback(() => {
    setProtecting(true)
    setProtectDeclined(false)
    void ensurePersistentStorage()
      .then(async (granted) => {
        const state = await queryPersistentStorage()
        setPersisted(state)
        // A silent refusal is the common Chromium answer on a fresh
        // profile; without saying so the button looks broken.
        setProtectDeclined(granted !== true && state !== true)
      })
      .finally(() => setProtecting(false))
  }, [])

  const installState = useSyncExternalStore(subscribeInstallState, getInstallState)

  // Journey evidence: what this browser keeps (estimate) and what a
  // connected companion keeps (report total). Queried once per visit — the
  // figures are orders-of-magnitude context, not a live meter.
  const [estimate, setEstimate] = useState<BrowserStorageEstimate | null>(null)
  useEffect(() => {
    let cancelled = false
    void queryStorageEstimate().then((value) => {
      if (!cancelled) setEstimate(value)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const [daemonStorageBytes, setDaemonStorageBytes] = useState<number | null>(null)
  const daemonBaseUrl = daemon?.baseUrl
  const daemonToken = daemon?.token
  useEffect(() => {
    if (daemonBaseUrl === undefined) {
      setDaemonStorageBytes(null)
      return
    }
    let cancelled = false
    const daemonFetch = createDaemonFetch(daemonBaseUrl, daemonToken ?? undefined)
    void (async () => {
      try {
        const res = await daemonFetch('/api/runtime/storage')
        if (!res.ok) return
        const report = storageReportPayloadSchema.parse(await res.json())
        if (!cancelled) setDaemonStorageBytes(report.totalBytes)
      } catch {
        // No figure — the step reads plain "connected".
      }
    })()
    return () => {
      cancelled = true
    }
  }, [daemonBaseUrl, daemonToken])

  const persistStep: PersistStepState = !persistedKnown
    ? 'unknown'
    : persisted === true
      ? 'granted'
      : persisted === null
        ? 'browser-managed'
        : 'todo'

  // Celebrate a step completing LIVE — never the page merely opening on an
  // already-complete step. The baseline is not recorded until the initial
  // persistence query answers, so the unknown->granted settle on mount does
  // not read as a transition.
  const persistDone = persisted === true
  const installDone = installState.status === 'installed'
  const celebratedBaseline = useRef<{ persist: boolean; install: boolean } | null>(null)
  useEffect(() => {
    if (!persistedKnown) return
    const prev = celebratedBaseline.current
    celebratedBaseline.current = { persist: persistDone, install: installDone }
    if (prev === null) return
    if (!prev.persist && persistDone) void celebrate(findVisibleJourneyBadge('protect'))
    if (!prev.install && installDone) void celebrate(findVisibleJourneyBadge('install'))
  }, [persistedKnown, persistDone, installDone])

  // Where "Back" leaves to. Captured once on mount from the state the gear
  // button passes; NOT a history pop — wandering between sections must never
  // change where Back exits, and a pop would land on the previous settings
  // section instead of leaving settings. Deep links and reloads have no
  // entry state and exit to the app root.
  const [entryPoint] = useState<string>(() => {
    const from = (location.state as { from?: unknown } | null)?.from
    return typeof from === 'string' ? from : '/'
  })
  const handleBackToApp = useCallback(() => {
    navigate(entryPoint)
  }, [navigate, entryPoint])

  const sharedProps = {
    theme,
    onThemeChange: setTheme,
    faviconStyle,
    onFaviconStyleChange: handleFaviconStyleChange,
    webMcpEnabled,
    onWebMcpToggle: handleWebMcpToggle,
    persistStep,
    protecting,
    protectDeclined,
    onProtect: handleProtect,
    installStatus: installState.status,
    estimate,
    daemonStorageBytes,
    daemon,
    onDisconnected,
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* Mobile (<sm): section list at /settings, full-width detail at
          /settings/<section>. */}
      <div className="sm:hidden" data-testid="settings-mobile">
        {routeSection === null ? (
          <div className="flex flex-col">
            <div className="flex items-center gap-2 border-b px-4 py-3">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleBackToApp}
                    aria-label="Back"
                    className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <ChevronLeft className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Back</TooltipContent>
              </Tooltip>
              <h1 className="text-sm font-semibold">Settings</h1>
            </div>
            <nav>
              {NAV_ITEMS.map(({ section, label, icon: Icon }) => (
                <Link
                  key={section}
                  to={settingsPath(section)}
                  state={location.state}
                  className="flex w-full items-center gap-3 border-b px-4 py-3 text-left text-sm hover:bg-accent"
                >
                  <Icon className="size-4 text-muted-foreground" />
                  <span className="flex-1">{label}</span>
                  <ChevronRight className="size-4 text-muted-foreground" />
                </Link>
              ))}
            </nav>
          </div>
        ) : (
          <div className="flex flex-col">
            <div className="flex items-center gap-2 border-b px-4 py-3">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Link
                    to={settingsPath()}
                    replace
                    state={location.state}
                    aria-label="Back to settings"
                    className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <ChevronLeft className="size-4" />
                  </Link>
                </TooltipTrigger>
                <TooltipContent>Back to settings</TooltipContent>
              </Tooltip>
              <h1 className="text-sm font-semibold">{SECTION_TITLE[routeSection]}</h1>
            </div>
            <div className="p-4">{sectionContent(routeSection, sharedProps)}</div>
          </div>
        )}
      </div>

      {/* Desktop (sm and up): sidebar + content pane. */}
      <div className="hidden h-full sm:flex sm:justify-center" data-testid="settings-desktop">
        <nav className="w-56 shrink-0 border-r p-4">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleBackToApp}
                aria-label="Back"
                className="mb-4 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <ChevronLeft className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Back</TooltipContent>
          </Tooltip>
          <div className="space-y-1">
            {NAV_ITEMS.map(({ section, label, icon: Icon }) => (
              <Link
                key={section}
                to={settingsPath(section)}
                replace
                state={location.state}
                aria-current={desktopSection === section ? 'page' : undefined}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                  desktopSection === section
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                }`}
              >
                <Icon className="size-4" />
                {label}
              </Link>
            ))}
          </div>
        </nav>
        <div className="w-full min-w-0 max-w-2xl overflow-y-auto p-6">
          <h1 className="mb-4 text-base font-semibold">{SECTION_TITLE[desktopSection]}</h1>
          {sectionContent(desktopSection, sharedProps)}
        </div>
      </div>
    </div>
  )
}
