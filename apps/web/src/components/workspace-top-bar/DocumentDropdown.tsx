import type { WorkspaceNames } from '@kamiazya/whiteboard-mcp/api-contracts'
import { ChevronDown, FilePlus2, Pin, Search } from 'lucide-react'
import { useMemo, useRef } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { DocumentItem } from './DocumentItem'
import {
  derivePinnedCanvases,
  filterDocumentsBySearch,
  groupCanvases,
  sortDocumentsByRecency,
} from './document-list'
import type { DocumentInfo } from './types'

interface DocumentDropdownProps {
  workspaceId: string
  path: string
  canvases: DocumentInfo[]
  effectiveNames: WorkspaceNames
  isLocalMode: boolean
  documentSearch: string
  onCanvasSearchChange: (value: string) => void
  onNavigateToDocument: (path: string) => void
  onTogglePin: (path: string, nextPinned: boolean) => void
  onOpenNewCanvas: () => void /** Renders a second creation entry for markdown-kind canvases (local mode). */
  onCreateMarkdown?: () => void
  // Both present (and >1 entry) render a "Workspaces" section above the
  // canvases section. Either omitted keeps every existing caller
  // (BrowserLocalDocumentPage, docs snapshots) byte-identical.
  workspaces?: string[]
  onSwitchWorkspace?: (workspaceId: string) => void
}

// The canvas switcher dropdown — workspace identity is intentionally hidden
// in OSS Local; the back-button returns to the flat canvas list and the name
// shown here is the canvas, not the workspace.
export function DocumentDropdown({
  workspaceId,
  path,
  canvases,
  effectiveNames,
  isLocalMode,
  documentSearch,
  onCanvasSearchChange,
  onNavigateToDocument,
  onTogglePin,
  onOpenNewCanvas,
  onCreateMarkdown,
  workspaces,
  onSwitchWorkspace,
}: DocumentDropdownProps) {
  const sortedCanvases = useMemo(() => sortDocumentsByRecency(canvases), [canvases])
  const filteredCanvases = useMemo(
    () => filterDocumentsBySearch(sortedCanvases, documentSearch, effectiveNames.canvases),
    [sortedCanvases, documentSearch, effectiveNames.canvases],
  )

  // Split canvases into pinned and regular sections.
  // Preserve the user-defined order in names.pinned instead of resorting those items by recency.
  const pinnedSet = useMemo(() => new Set(effectiveNames.pinned), [effectiveNames.pinned])
  const pinnedCanvases = useMemo(
    () => derivePinnedCanvases(filteredCanvases, effectiveNames.pinned),
    [filteredCanvases, effectiveNames.pinned],
  )

  // Group by path prefix (the first segment). Canvases without "/" stay in the ungrouped bucket.
  // Preserve recency order within each group and exclude anything already shown in the pinned section.
  const groupedDocuments = useMemo(
    () => groupCanvases(filteredCanvases, pinnedSet),
    [filteredCanvases, pinnedSet],
  )

  const navigate = (targetPath: string) => {
    onNavigateToDocument(targetPath)
    onCanvasSearchChange('')
  }

  // Browser-local has no workspace NAME to show — `workspaceId` is the
  // literal "local" — so the mode is the honest label there. A daemon
  // workspace prefers its stored name and falls back to the id, which is
  // what the user sees before anyone has named it.
  const workspaceLabel = isLocalMode ? 'Local' : (effectiveNames.workspace ?? workspaceId)

  // The search box takes autoFocus on open, which wins the mount-focus race
  // against Radix's own DismissableLayer/FocusScope (it only auto-focuses
  // the content when nothing inside already has focus) — so a real DOM
  // item is never focused yet for Radix's roving-focus arrow handling to
  // act on (that handling only fires for keydowns whose target IS the
  // roving item itself). ArrowDown from the search box forwards focus onto
  // the first roving item so keyboard-only users can still reach the list
  // without a mouse.
  const contentRef = useRef<HTMLDivElement>(null)
  const focusFirstItem = () => {
    contentRef.current
      ?.querySelector<HTMLElement>('[role="menuitemradio"], [role="menuitem"]')
      ?.focus()
  }

  return (
    // modal={false}: Radix's modal menus TRAP focus for their whole
    // lifetime, exit animation included. A selection that swaps in a fresh
    // editor races that animation — the editor autofocuses on mount, the
    // still-animating menu content yanks focus back into itself, then
    // unmounts and drops it on <body>. Nothing recovers from there, because
    // the editor's focus is one-shot on mount.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          // The WORKSPACE, not the canvas. The canvas's name is row two's
          // title field; naming it here too meant editing one and watching
          // the other lag, and read as two different things being named.
          // Picking a canvas from this menu is navigation within the
          // workspace, which is what the label now says.
          aria-label={`Workspace: ${workspaceLabel}`}
          className="flex min-w-0 items-center gap-1 truncate rounded px-1.5 py-0.5 text-sm hover:bg-accent"
        >
          <span className="truncate font-semibold">{workspaceLabel}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        ref={contentRef}
        // Let Radix handle the single scroll container.
        // Search stays sticky at the top and the footer stays sticky at the bottom.
        className="w-[320px] p-0"
        align="start"
        // Radix's default close behavior returns focus to the trigger
        // ASYNCHRONOUSLY. When a menu item switches to a fresh editor that
        // takes focus itself (New markdown note…), that late focus return
        // steals the keyboard mid-word — keystrokes silently land on the
        // trigger, and a Space reopens the menu. The selections that matter
        // here mount a surface that takes focus itself, so the trigger is
        // never where focus should end up.
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <div className="sticky top-0 z-10 border-b bg-popover p-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={documentSearch}
              onChange={(e) => onCanvasSearchChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  focusFirstItem()
                }
              }}
              placeholder="Switch canvas…"
              className="h-8 pl-7 text-xs"
              autoFocus
            />
          </div>
        </div>
        {workspaces && onSwitchWorkspace && workspaces.length > 1 && documentSearch === '' && (
          <div className="border-b p-1">
            <DropdownMenuLabel className="px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              Workspaces
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={workspaceId}
              onValueChange={(nextWorkspaceId) => {
                // Radix's RadioItem fires onSelect (hence this) for the
                // already-checked item too — the no-op guard lives here,
                // not in Radix, or re-picking the current workspace would
                // jump the user to that workspace's first canvas for
                // nothing.
                if (nextWorkspaceId !== workspaceId) onSwitchWorkspace(nextWorkspaceId)
              }}
            >
              {workspaces.map((id) => (
                <DropdownMenuRadioItem key={id} value={id}>
                  {id}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </div>
        )}
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
                      <DocumentItem
                        key={c.path}
                        canvas={c}
                        workspaceId={workspaceId}
                        customName={effectiveNames.canvases[c.path]}
                        // Keep the full path in the pinned section so the original group context stays visible.
                        leafLabel={effectiveNames.canvases[c.path] ?? c.path}
                        active={c.path === path}
                        pinned={true}
                        isLocalMode={isLocalMode}
                        onNavigate={() => navigate(c.path)}
                        onTogglePin={onTogglePin}
                      />
                    ))}
                  </div>
                )}
                {groupedDocuments.map(([group, items], gi) => (
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
                      const leafSegment = group === '' ? c.path : c.path.slice(group.length + 1)
                      return (
                        <DocumentItem
                          key={c.path}
                          canvas={c}
                          workspaceId={workspaceId}
                          customName={effectiveNames.canvases[c.path]}
                          leafLabel={effectiveNames.canvases[c.path] ?? leafSegment}
                          active={c.path === path}
                          pinned={false}
                          isLocalMode={isLocalMode}
                          onNavigate={() => navigate(c.path)}
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
            data-testid="new-document-menu-item"
            onSelect={onOpenNewCanvas}
            className="gap-2 rounded-none font-medium"
          >
            <FilePlus2 className="size-3.5" />
            New canvas…
          </DropdownMenuItem>
          {onCreateMarkdown !== undefined && (
            <DropdownMenuItem
              data-testid="new-markdown-menu-item"
              onSelect={onCreateMarkdown}
              className="gap-2 rounded-none font-medium"
            >
              <FilePlus2 className="size-3.5" />
              New markdown note…
            </DropdownMenuItem>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
