import { EllipsisVertical, Maximize2, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ThemeMode } from '@/hooks/useThemeMode'
import { ThemeToggleButton } from '../ThemeToggleButton'

// Mirrors ThemeToggleButton's cycle order (system → light → dark → system).
// Duplicated here — rather than exported from ThemeToggleButton — because the
// two callers render different UI shapes (icon button vs. menu item); keep
// this in sync with ThemeToggleButton.tsx's NEXT map if that cycle changes.
const THEME_CYCLE: Record<ThemeMode, ThemeMode> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
}

interface TopBarSecondaryActionsProps {
  theme?: ThemeMode
  onToggleTheme?: (next: ThemeMode) => void
  onEnterFullscreen?: () => void
  onOpenSettings?: () => void
}

// Right side: theme and fullscreen — plus the "More actions" kebab that
// reuses the exact same handlers below 400px so the header never wraps.
// Version history moved to the canvas's HistoryCluster (bottom-left).
export function TopBarSecondaryActions({
  theme,
  onToggleTheme,
  onEnterFullscreen,
  onOpenSettings,
}: TopBarSecondaryActionsProps) {
  return (
    <>
      <div
        data-testid="topbar-right-actions-exposed"
        className="flex shrink-0 items-center gap-1 max-[400px]:hidden"
      >
        {onToggleTheme && theme && <ThemeToggleButton theme={theme} onChange={onToggleTheme} />}
        {onEnterFullscreen && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="size-8 p-0"
                onClick={onEnterFullscreen}
                aria-label="Fullscreen"
              >
                <Maximize2 className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Fullscreen (f)</TooltipContent>
          </Tooltip>
        )}
        {onOpenSettings && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="size-8 p-0"
                onClick={onOpenSettings}
                aria-label="Settings"
                data-testid="settings-trigger"
              >
                <Settings className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Settings</TooltipContent>
          </Tooltip>
        )}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="More actions"
            data-testid="topbar-more-actions-trigger"
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground min-[400px]:hidden"
          >
            <EllipsisVertical className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {onToggleTheme && theme && (
            <DropdownMenuItem
              onSelect={() => onToggleTheme(THEME_CYCLE[theme])}
              className="gap-2"
              aria-label={`Theme: ${theme}`}
            >
              Theme
            </DropdownMenuItem>
          )}
          {onEnterFullscreen && (
            <DropdownMenuItem onSelect={onEnterFullscreen} className="gap-2">
              <Maximize2 className="size-3.5" />
              Fullscreen
            </DropdownMenuItem>
          )}
          {onOpenSettings && (
            <DropdownMenuItem onSelect={onOpenSettings} className="gap-2">
              <Settings className="size-3.5" />
              Settings
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
