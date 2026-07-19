import { Monitor, Moon, Palette, Sun } from 'lucide-react'
import { useCallback, useId, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { ThemeMode } from '@/hooks/useThemeMode'
import { createUserSettingsStore } from '@/lib/user-settings-store'

interface SettingsPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  theme: ThemeMode
  onThemeChange: (next: ThemeMode) => void
  onWebMcpChange?: (enabled: boolean) => void
}

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string; icon: typeof Sun }> = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
]

const settingsStore = createUserSettingsStore()

export function SettingsPanel({
  open,
  onOpenChange,
  theme,
  onThemeChange,
  onWebMcpChange,
}: SettingsPanelProps) {
  const themeGroupId = useId()

  const [webMcpEnabled, setWebMcpEnabled] = useState(() => {
    const settings = settingsStore.load()
    return settings.capabilities.webMcpEnabled ?? true
  })

  const handleWebMcpToggle = useCallback(() => {
    setWebMcpEnabled((prev) => {
      const next = !prev
      settingsStore.update((s) => ({
        ...s,
        capabilities: { ...s.capabilities, webMcpEnabled: next },
      }))
      onWebMcpChange?.(next)
      return next
    })
  }, [onWebMcpChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
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
          </section>

          {/* Capabilities section */}
          <section>
            <h3 className="mb-3 text-sm font-medium">Capabilities</h3>
            <label className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm">WebMCP</p>
                <p className="text-xs text-muted-foreground">
                  Expose canvas tools to AI agents via WebMCP
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={webMcpEnabled}
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
            </label>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
