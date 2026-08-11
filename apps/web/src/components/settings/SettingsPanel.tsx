import { Grid2x2, Monitor, Moon, Palette, Sun, Waves } from 'lucide-react'
import type { ReactNode } from 'react'
import { useCallback, useId, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { ThemeMode } from '@/hooks/useThemeMode'
import type { FaviconStyle } from '@/lib/favicon'
import { createUserSettingsStore } from '@/lib/user-settings-store'

interface SettingsPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  theme: ThemeMode
  onThemeChange: (next: ThemeMode) => void
  webMcpEnabled: boolean
  onWebMcpChange?: (enabled: boolean) => void
  onFaviconStyleChange?: (style: FaviconStyle) => void
  // Host-supplied operational sections: the daemon
  // index passes its Paired-web-apps and Storage cards here so those
  // surfaces live under Settings instead of a top-level tab. Browser-local
  // hosts omit it.
  extraSections?: ReactNode
}

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string; icon: typeof Sun }> = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
]

const FAVICON_OPTIONS: Array<{ value: FaviconStyle; label: string; icon: typeof Sun }> = [
  { value: 'minimap', label: 'Minimap', icon: Grid2x2 },
  { value: 'dot', label: 'Dot only', icon: Waves },
]

const settingsStore = createUserSettingsStore()

export function SettingsPanel({
  open,
  onOpenChange,
  theme,
  onThemeChange,
  webMcpEnabled,
  onWebMcpChange,
  onFaviconStyleChange,
  extraSections,
}: SettingsPanelProps) {
  const themeGroupId = useId()
  const faviconGroupId = useId()
  const [faviconStyle, setFaviconStyle] = useState<FaviconStyle>(
    () => settingsStore.load().appearance?.faviconStyle ?? 'minimap',
  )
  const handleFaviconStyle = useCallback(
    (next: FaviconStyle) => {
      setFaviconStyle(next)
      settingsStore.update((s) => ({
        ...s,
        appearance: { ...s.appearance, faviconStyle: next },
      }))
      onFaviconStyleChange?.(next)
    },
    [onFaviconStyleChange],
  )
  const webMcpLabelId = useId()
  const webMcpDescId = useId()

  const handleWebMcpToggle = useCallback(() => {
    const next = !webMcpEnabled
    settingsStore.update((s) => ({
      ...s,
      capabilities: { ...s.capabilities, webMcpEnabled: next },
    }))
    onWebMcpChange?.(next)
  }, [webMcpEnabled, onWebMcpChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[85dvh] overflow-y-auto sm:max-w-md data-[has-extra=true]:sm:max-w-xl"
        data-has-extra={extraSections != null}
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription className="sr-only">Application settings</DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Appearance section */}
          <section aria-labelledby={themeGroupId}>
            <h3 id={themeGroupId} className="mb-3 flex items-center gap-2 text-sm font-medium">
              <Palette className="size-4" />
              Appearance
            </h3>
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
                Tab icon — Minimap mirrors the canvas content; Dot only keeps the plain mark. Both
                carry the save/sync status dot.
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
                    onClick={() => handleFaviconStyle(value)}
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

          {/* Capabilities section */}
          <section>
            <h3 className="mb-3 text-sm font-medium">Capabilities</h3>
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
                onClick={handleWebMcpToggle}
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

          {extraSections}
        </div>
      </DialogContent>
    </Dialog>
  )
}
