import {
  Cable,
  ChevronRight,
  Database,
  Grid2x2,
  Monitor,
  Moon,
  Palette,
  Sun,
  Waves,
} from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { AppVersionRow } from '@/components/settings/AppVersionRow'
import type { PersistStepState } from '@/components/settings/SetupJourney'
import { findVisibleJourneyBadge, SetupJourney } from '@/components/settings/SetupJourney'
import { DaemonApiContext } from '@/contexts/DaemonApiContext'
import { useThemeMode } from '@/hooks/useThemeMode'
import { parseSettingsRoute, type SettingsSection, settingsPath } from '@/lib/app-routes'
import { celebrate } from '@/lib/celebrate'
import { createDaemonFetch } from '@/lib/daemon-api-client'
import type { FaviconStyle } from '@/lib/favicon'
import { getInstallState, promptInstall, subscribeInstallState } from '@/lib/install-prompt-store'
import { ensurePersistentStorage, queryPersistentStorage } from '@/lib/persistent-storage'
import { createUserSettingsStore } from '@/lib/user-settings-store'
import { PairedOriginsCard } from '../components/PairedOriginsCard.js'
import { StorageReportCard } from '../components/StorageReportCard.js'

export interface SettingsPageProps {
  daemon?: { baseUrl: string; token: string | null }
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
  { section: 'connections', label: 'Connections', icon: Cable },
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
              Lets in-page scripts in supporting browsers read a canvas summary (identifier,
              selection count, viewport). Never exposes secrets, tokens, or full scene content.
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
function ConnectionsSection({ daemon }: { daemon?: { baseUrl: string; token: string | null } }) {
  if (!daemon) {
    return (
      <section>
        <p className="text-sm">Local daemon — Not connected</p>
        <p className="mt-1 text-xs text-muted-foreground">
          A local daemon holds durable storage and the AI agent connection for this app.
        </p>
      </section>
    )
  }
  const daemonFetch = createDaemonFetch(daemon.baseUrl, daemon.token ?? undefined)
  return (
    <DaemonApiContext.Provider value={daemonFetch}>
      <div className="space-y-6">
        <section aria-label="Paired web apps">
          <PairedOriginsCard />
        </section>
        <section aria-label="Storage">
          <StorageReportCard />
        </section>
      </div>
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
    daemon?: { baseUrl: string; token: string | null }
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
          />
          <div className="mt-6 border-t pt-4">
            <AppVersionRow />
          </div>
        </div>
      )
    case 'connections':
      return <ConnectionsSection daemon={props.daemon} />
  }
}

const SECTION_TITLE: Record<SettingsSection, string> = {
  general: 'General',
  data: 'Data & app',
  connections: 'Connections',
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
export function SettingsPage({ daemon }: SettingsPageProps) {
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
    daemon,
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* Mobile (<sm): section list at /settings, full-width detail at
          /settings/<section>. */}
      <div className="sm:hidden" data-testid="settings-mobile">
        {routeSection === null ? (
          <div className="flex flex-col">
            <div className="flex items-center gap-2 border-b px-4 py-3">
              <button
                type="button"
                onClick={handleBackToApp}
                className="rounded-md p-1 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <span aria-hidden="true">← </span>Back
              </button>
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
              <Link
                to={settingsPath()}
                replace
                state={location.state}
                className="rounded-md p-1 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <span aria-hidden="true">← </span>Settings
              </Link>
              <h1 className="text-sm font-semibold">{SECTION_TITLE[routeSection]}</h1>
            </div>
            <div className="p-4">{sectionContent(routeSection, sharedProps)}</div>
          </div>
        )}
      </div>

      {/* Desktop (sm and up): sidebar + content pane. */}
      <div className="hidden h-full sm:flex sm:justify-center" data-testid="settings-desktop">
        <nav className="w-56 shrink-0 border-r p-4">
          <button
            type="button"
            onClick={handleBackToApp}
            className="mb-4 rounded-md px-1 py-1 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <span aria-hidden="true">← </span>Back
          </button>
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
