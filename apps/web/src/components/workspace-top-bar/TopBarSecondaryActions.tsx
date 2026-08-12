import { EllipsisVertical, Maximize2, Minimize2, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

interface TopBarSecondaryActionsProps {
  /**
   * Toggles rather than only entering: the fullscreen element is the page's
   * `<main>`, which CONTAINS this header, so the header stays on screen and
   * is the only exit affordance there is. Enter-only left no way back.
   */
  onToggleFullscreen?: () => void
  isFullscreen?: boolean
  onOpenSettings?: () => void
  /** Blue attention dot on the settings entry points (outstanding setup todo or waiting update). */
  settingsNudge?: boolean
}

// Right side: fullscreen and settings — plus the "View options" kebab that
// reuses the exact same handlers below 400px so the header never wraps.
//
// Theme deliberately absent: Settings owns the full three-way choice
// (system/light/dark), and a header button that cycles the same setting is a
// second control for one piece of state.
export function TopBarSecondaryActions({
  onToggleFullscreen,
  isFullscreen = false,
  onOpenSettings,
  settingsNudge,
}: TopBarSecondaryActionsProps) {
  const fullscreenLabel = isFullscreen ? 'Exit fullscreen' : 'Fullscreen'
  const FullscreenIcon = isFullscreen ? Minimize2 : Maximize2

  return (
    <>
      <div
        data-testid="topbar-right-actions-exposed"
        className="flex shrink-0 items-center gap-1 max-[400px]:hidden"
      >
        {onToggleFullscreen && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="size-8 p-0"
                onClick={onToggleFullscreen}
                aria-label={fullscreenLabel}
              >
                <FullscreenIcon className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{fullscreenLabel} (f)</TooltipContent>
          </Tooltip>
        )}
        {onOpenSettings && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="relative size-8 p-0"
                onClick={onOpenSettings}
                aria-label="Settings"
                data-testid="settings-trigger"
              >
                {settingsNudge && (
                  <span
                    data-testid="settings-nudge"
                    aria-hidden="true"
                    className="absolute right-0.5 top-0.5 size-2 rounded-full bg-[#3b6ecc] ring-2 ring-background"
                  />
                )}
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
            aria-label="View options"
            data-testid="topbar-more-actions-trigger"
            className="relative shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground min-[400px]:hidden"
          >
            {settingsNudge && onOpenSettings && (
              <span
                aria-hidden="true"
                className="absolute right-0 top-0 size-2 rounded-full bg-[#3b6ecc] ring-2 ring-background"
              />
            )}
            <EllipsisVertical className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {onToggleFullscreen && (
            <DropdownMenuItem onSelect={onToggleFullscreen} className="gap-2">
              <FullscreenIcon className="size-3.5" />
              {fullscreenLabel}
            </DropdownMenuItem>
          )}
          {onOpenSettings && (
            <DropdownMenuItem onSelect={onOpenSettings} className="gap-2">
              <Settings className="size-3.5" />
              Settings
              {settingsNudge && (
                <span aria-hidden="true" className="ml-auto size-2 rounded-full bg-[#3b6ecc]" />
              )}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
