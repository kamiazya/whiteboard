import { FileText, Pin } from 'lucide-react'
import { CanvasThumb } from '@/components/CanvasThumb'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import type { CanvasInfo } from './types'

interface CanvasItemProps {
  canvas: CanvasInfo
  workspaceId: string
  customName: string | undefined
  leafLabel: string
  active: boolean
  pinned: boolean
  isLocalMode: boolean
  onNavigate: () => void
  onTogglePin: (slug: string, nextPinned: boolean) => void
}

// Dropdown item with thumbnail, name, optional slug subtitle, and a pin toggle.
// Keep the pin control on the right edge. Show it constantly when pinned, otherwise reveal it on hover.
// Stop propagation on mouse down because Radix selection is driven from that event.
export function CanvasItem({
  canvas,
  workspaceId,
  customName,
  leafLabel,
  active,
  pinned,
  isLocalMode,
  onNavigate,
  onTogglePin,
}: CanvasItemProps) {
  return (
    <DropdownMenuItem
      onSelect={onNavigate}
      className={cn('group flex items-center gap-2', active && 'bg-accent')}
    >
      {/* Local mode has no daemon to fetch /latest-thumbnail from — CanvasThumb's
          only other branch (useHasDaemonApi) is false here (no provider is
          mounted), so it would otherwise render a plain <img src="/api/...">
          whose GET fires from the browser's image loader, invisible to any
          fetch spy. Skip the component entirely rather than rely on that
          fallback. */}
      {isLocalMode ? (
        <div className="flex h-9 w-14 shrink-0 items-center justify-center overflow-hidden rounded border bg-muted/40">
          <FileText className="size-4 text-muted-foreground/50" />
        </div>
      ) : (
        <CanvasThumb workspaceId={workspaceId} slug={canvas.slug} />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn('truncate text-sm', active ? 'font-semibold text-primary' : 'font-medium')}
        >
          {leafLabel}
        </span>
        {customName && customName !== canvas.slug && (
          <span className="truncate font-mono text-[10px] text-muted-foreground">
            {canvas.slug}
          </span>
        )}
      </div>
      {/* Pin has no local-mode backend (no /pin endpoint to persist against),
          so the affordance is hidden rather than shipped as a no-op button. */}
      {!isLocalMode && (
        <button
          type="button"
          aria-label={pinned ? 'Unpin canvas' : 'Pin canvas'}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            e.preventDefault()
            onTogglePin(canvas.slug, !pinned)
          }}
          className={cn(
            'shrink-0 rounded p-1 text-muted-foreground hover:bg-accent-foreground/10 hover:text-foreground transition-opacity',
            pinned ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100',
          )}
        >
          <Pin className={cn('size-3.5', pinned && 'fill-current')} />
        </button>
      )}
    </DropdownMenuItem>
  )
}
