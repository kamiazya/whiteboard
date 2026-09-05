import { EllipsisVertical, Maximize2, Minimize2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from '../../components/ui/button.js'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip.js'
import { isFullscreenSupported } from '../../lib/fullscreen-support.js'

interface TopBarSecondaryActionsProps {
  /**
   * Toggles rather than only entering: the fullscreen element is the page's
   * `<main>`, which CONTAINS this header, so the header stays on screen and
   * is the only exit affordance there is. Enter-only left no way back.
   */
  onToggleFullscreen?: () => void
  isFullscreen?: boolean
}

// Right side: fullscreen — plus the "View options" kebab that reuses the
// same handler below 400px so the header never wraps. Settings and the brand
// mark live in the AppShell, never here.
export function TopBarSecondaryActions({
  onToggleFullscreen,
  isFullscreen = false,
}: TopBarSecondaryActionsProps) {
  const fullscreenLabel = isFullscreen ? 'Exit fullscreen' : 'Fullscreen'
  const FullscreenIcon = isFullscreen ? Minimize2 : Maximize2
  // Hidden rather than disabled where the browser has no element
  // fullscreen (iPhone Safari — video-only): a disabled control still
  // claims header space and invites a tap that can never work, and there
  // is nothing the user could change to enable it. Read once per mount,
  // since it cannot change without a navigation.
  const [fullscreenAvailable] = useState(isFullscreenSupported)
  const showFullscreen = onToggleFullscreen !== undefined && fullscreenAvailable

  return (
    <>
      <div
        data-testid="topbar-right-actions-exposed"
        className="flex shrink-0 items-center gap-1 max-[400px]:hidden"
      >
        {showFullscreen && (
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
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="View options"
            data-testid="topbar-more-actions-trigger"
            className="relative shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground min-[400px]:hidden"
          >
            <EllipsisVertical className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {showFullscreen && (
            <DropdownMenuItem onSelect={onToggleFullscreen} className="gap-2">
              <FullscreenIcon className="size-3.5" />
              {fullscreenLabel}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
