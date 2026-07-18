import type { WorkspaceNames } from '@kamiazya/whiteboard-mcp/api-contracts'
import { ChevronDown, FilePlus2, Pin, Search } from 'lucide-react'
import { useMemo } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { CanvasItem } from './CanvasItem'
import {
  derivePinnedCanvases,
  filterCanvasesBySearch,
  groupCanvases,
  sortCanvasesByRecency,
} from './canvas-list'
import type { CanvasInfo } from './types'

interface CanvasDropdownProps {
  workspaceId: string
  slug: string
  canvases: CanvasInfo[]
  effectiveNames: WorkspaceNames
  isLocalMode: boolean
  canvasFlat: string | null
  canvasPrefix: string | null
  canvasLeaf: string | null
  canvasSearch: string
  onCanvasSearchChange: (value: string) => void
  onNavigateToCanvas: (slug: string) => void
  onTogglePin: (slug: string, nextPinned: boolean) => void
  onOpenNewCanvas: () => void
}

// The canvas switcher dropdown — workspace identity is intentionally hidden
// in OSS Local; the back-button returns to the flat canvas list and the name
// shown here is the canvas, not the workspace.
export function CanvasDropdown({
  workspaceId,
  slug,
  canvases,
  effectiveNames,
  isLocalMode,
  canvasFlat,
  canvasPrefix,
  canvasLeaf,
  canvasSearch,
  onCanvasSearchChange,
  onNavigateToCanvas,
  onTogglePin,
  onOpenNewCanvas,
}: CanvasDropdownProps) {
  const sortedCanvases = useMemo(() => sortCanvasesByRecency(canvases), [canvases])
  const filteredCanvases = useMemo(
    () => filterCanvasesBySearch(sortedCanvases, canvasSearch, effectiveNames.canvases),
    [sortedCanvases, canvasSearch, effectiveNames.canvases],
  )

  // Split canvases into pinned and regular sections.
  // Preserve the user-defined order in names.pinned instead of resorting those items by recency.
  const pinnedSet = useMemo(() => new Set(effectiveNames.pinned), [effectiveNames.pinned])
  const pinnedCanvases = useMemo(
    () => derivePinnedCanvases(filteredCanvases, effectiveNames.pinned),
    [filteredCanvases, effectiveNames.pinned],
  )

  // Group by slug prefix (the first segment). Canvases without "/" stay in the ungrouped bucket.
  // Preserve recency order within each group and exclude anything already shown in the pinned section.
  const groupedCanvases = useMemo(
    () => groupCanvases(filteredCanvases, pinnedSet),
    [filteredCanvases, pinnedSet],
  )

  const navigate = (targetSlug: string) => {
    onNavigateToCanvas(targetSlug)
    onCanvasSearchChange('')
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex min-w-0 items-center gap-1 truncate rounded px-1.5 py-0.5 text-sm hover:bg-accent"
        >
          {canvasFlat !== null ? (
            <span className="truncate font-semibold">{canvasFlat}</span>
          ) : (
            <>
              <span className="truncate text-muted-foreground">{canvasPrefix}</span>
              <span className="shrink-0 text-muted-foreground/60">/</span>
              <span className="truncate font-semibold">{canvasLeaf}</span>
            </>
          )}
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        // Let Radix handle the single scroll container.
        // Search stays sticky at the top and the footer stays sticky at the bottom.
        className="w-[320px] p-0"
        align="start"
      >
        <div className="sticky top-0 z-10 border-b bg-popover p-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={canvasSearch}
              onChange={(e) => onCanvasSearchChange(e.target.value)}
              placeholder="Switch canvas…"
              className="h-8 pl-7 text-xs"
              autoFocus
            />
          </div>
        </div>
        <div className="max-h-[300px] overflow-y-auto">
          <div className="flex flex-col p-1">
            {filteredCanvases.length === 0 ? (
              <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                No matching canvas.
              </div>
            ) : (
              <>
                {pinnedCanvases.length > 0 && (
                  <div className="mb-1">
                    <DropdownMenuLabel className="px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                      <Pin className="size-3 fill-current" />
                      Pinned
                    </DropdownMenuLabel>
                    {pinnedCanvases.map((c) => (
                      <CanvasItem
                        key={c.slug}
                        canvas={c}
                        workspaceId={workspaceId}
                        customName={effectiveNames.canvases[c.slug]}
                        // Keep the full slug in the pinned section so the original group context stays visible.
                        leafLabel={effectiveNames.canvases[c.slug] ?? c.slug}
                        active={c.slug === slug}
                        pinned={true}
                        isLocalMode={isLocalMode}
                        onNavigate={() => navigate(c.slug)}
                        onTogglePin={onTogglePin}
                      />
                    ))}
                  </div>
                )}
                {groupedCanvases.map(([group, items], gi) => (
                  <div
                    key={group || '__ungrouped__'}
                    className={gi > 0 || pinnedCanvases.length > 0 ? 'mt-1' : ''}
                  >
                    {group !== '' && (
                      <DropdownMenuLabel className="px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                        {group}
                      </DropdownMenuLabel>
                    )}
                    {items.map((c) => {
                      const leafSlug = group === '' ? c.slug : c.slug.slice(group.length + 1)
                      return (
                        <CanvasItem
                          key={c.slug}
                          canvas={c}
                          workspaceId={workspaceId}
                          customName={effectiveNames.canvases[c.slug]}
                          leafLabel={effectiveNames.canvases[c.slug] ?? leafSlug}
                          active={c.slug === slug}
                          pinned={false}
                          isLocalMode={isLocalMode}
                          onNavigate={() => navigate(c.slug)}
                          onTogglePin={onTogglePin}
                        />
                      )
                    })}
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
        <div className="sticky bottom-0 z-10 border-t bg-popover">
          <DropdownMenuItem
            data-testid="new-canvas-menu-item"
            onSelect={onOpenNewCanvas}
            className="gap-2 rounded-none font-medium"
          >
            <FilePlus2 className="size-3.5" />
            New canvas…
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
