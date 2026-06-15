import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  ChevronLeft,
  ChevronDown,
  History,
  Maximize2,
  Pencil,
  Copy,
  FilePlus2,
  Pin,
  Search,
} from 'lucide-react'
import { ThemeToggleButton } from './ThemeToggleButton.js'
import type { ThemeMode } from '../hooks/useThemeMode.js'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  saveVersionResponseSchema,
  problemDetailsErrorSchema,
} from '../../shared/api-contracts/canvas.js'
import { apiFetch } from '../lib/api-client.js'
import VersionTimeline from './VersionTimeline.js'
import { CanvasThumb } from './CanvasThumb.js'
import { HeaderBranchChip } from './HeaderBranchChip.js'
import { HeaderSaveDot } from './HeaderSaveDot.js'
import { useDirtyState } from '../hooks/useDirtyState.js'
import { getAppLogger } from '../lib/app-logger.js'

interface CanvasInfo {
  slug: string
  updatedAt: string
}

// CanvasThumb is shared with IndexPage; see ./CanvasThumb.tsx.

interface WorkspaceNames {
  workspace?: string
  canvases: Record<string, string>
  // Slugs pinned to the top of the canvas switcher. Array order is display order.
  pinned: string[]
}

// Dropdown item with thumbnail, name, optional slug subtitle, and a pin toggle.
// Keep the pin control on the right edge. Show it constantly when pinned, otherwise reveal it on hover.
// Stop propagation on mouse down because Radix selection is driven from that event.
function CanvasItem({
  canvas,
  workspaceId,
  customName,
  leafLabel,
  active,
  pinned,
  onNavigate,
  onTogglePin,
}: {
  canvas: CanvasInfo
  workspaceId: string
  customName: string | undefined
  leafLabel: string
  active: boolean
  pinned: boolean
  onNavigate: () => void
  onTogglePin: (slug: string, nextPinned: boolean) => void
}) {
  return (
    <DropdownMenuItem
      onSelect={onNavigate}
      className={cn('group flex items-center gap-2', active && 'bg-accent')}
    >
      <CanvasThumb workspaceId={workspaceId} slug={canvas.slug} />
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
    </DropdownMenuItem>
  )
}

interface Props {
  workspaceId: string
  slug: string
  canvases: CanvasInfo[]
  onRestored?: () => void
  onEnterFullscreen: () => void
  getThumbnailBlob?: () => Promise<Blob | null>
  // Theme preference is owned by the page so reloads can rehydrate from
  // localStorage and pass the resolved value to <Excalidraw theme=...>. The
  // button cycles light → dark → system.
  theme?: ThemeMode
  onToggleTheme?: (next: ThemeMode) => void
}

// Give the canvas visual priority and keep the surrounding chrome lightweight.
// - Only a 48px top bar; Excalidraw keeps the full width
// - Left: back to workspace, inline workspace rename, and the canvas switcher
// - Right: version history, fullscreen, and canvas rename actions
// - More complex lists appear on demand through buttons and popovers

export default function WorkspaceTopBar({
  workspaceId,
  slug,
  canvases,
  onRestored,
  theme,
  onToggleTheme,
  onEnterFullscreen,
  getThumbnailBlob,
}: Props) {
  const log = getAppLogger('workspace-top-bar')
  const navigate = useNavigate()
  const [names, setNames] = useState<WorkspaceNames>({ canvases: {}, pinned: [] })
  const [renamingCanvas, setRenamingCanvas] = useState(false)
  const [draft, setDraft] = useState('')
  const [versionOpen, setVersionOpen] = useState(false)
  const [canvasSearch, setCanvasSearch] = useState('')
  const versionPanelRef = useRef<HTMLDivElement | null>(null)

  // Save state: dirty dot + Cmd/Ctrl+S only.
  // No beforeunload guard: every Excalidraw edit flows through useWhiteboardSync
  // → LoroDoc → WebSocket → daemon → SQLite blob in real time, so closing the
  // tab cannot lose persisted content. The dirty dot here only tracks
  // "haven't named a manual version yet"; warning the user about it via the
  // browser's leave-confirmation dialog is misleading and was getting in the
  // way of automation (e.g. Playwright workflows).
  const { isDirty } = useDirtyState(workspaceId, slug)
  const [saving, setSaving] = useState(false)
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform)
  const shortcutHint = isMac ? '⌘S' : 'Ctrl+S'

  // Shared save flow: POST /versions, then upload a thumbnail if available.
  // Quick save passes an empty label.
  const saveVersion = useCallback(
    async (label = ''): Promise<boolean> => {
      if (saving) return false
      setSaving(true)
      try {
        const res = await apiFetch(
          `/api/workspaces/${workspaceId}/canvases/${encodeURIComponent(slug)}/versions`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ label }),
          },
        )
        if (!res.ok) return false
        const parsed = saveVersionResponseSchema.safeParse(await res.json().catch(() => null))
        if (!parsed.success) {
          log.error('POST /versions response did not match schema:', parsed.error)
          return false
        }
        // Dispatch only after schema validation confirms the server response is well-formed.
        // Manual save can bypass the server's version_created websocket path; a later WS event becomes a no-op.
        if (typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent('excalidraw:version_saved', {
              detail: { workspaceId, slug },
            }),
          )
        }
        const id = parsed.data.version.id
        if (id && getThumbnailBlob) {
          try {
            const blob = await getThumbnailBlob()
            if (blob) {
              await apiFetch(
                `/api/workspaces/${workspaceId}/canvases/${encodeURIComponent(slug)}/versions/${id}/thumbnail`,
                {
                  method: 'PUT',
                  headers: { 'Content-Type': 'image/png' },
                  body: blob,
                },
              )
            }
          } catch (err) {
            log.error('manual-save thumbnail upload failed:', err)
          }
        }
        return true
      } finally {
        setSaving(false)
      }
    },
    [workspaceId, slug, saving, getThumbnailBlob],
  )

  // Cmd/Ctrl+S performs a quick save.
  // Excalidraw can focus an offscreen contenteditable for clipboard or IME work, which makes
  // browser-level heuristics think the user is typing and can reopen the native Save Page dialog.
  // Capture the shortcut unconditionally here because the canvas has no competing native save meaning.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isSave = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && !e.shiftKey
      if (!isSave) return
      e.preventDefault()
      e.stopPropagation()
      void saveVersion('')
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () =>
      window.removeEventListener('keydown', onKey, { capture: true } as EventListenerOptions)
  }, [saveVersion])

  // New canvas dialog state. Seed the slug with the current group's prefix for faster repeated creation.
  const [newCanvasOpen, setNewCanvasOpen] = useState(false)
  const [newCanvasSlug, setNewCanvasSlug] = useState('')
  const [newCanvasError, setNewCanvasError] = useState<string | null>(null)
  const [newCanvasBusy, setNewCanvasBusy] = useState(false)

  // Load display names.
  const fetchNames = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/workspaces/${workspaceId}/names`)
      if (res.ok) setNames((await res.json()) as WorkspaceNames)
    } catch {
      /* best-effort */
    }
  }, [workspaceId])

  useEffect(() => {
    fetchNames()
  }, [fetchNames])

  const commitCanvasName = async () => {
    const name = draft.trim()
    try {
      const res = await apiFetch(
        `/api/workspaces/${workspaceId}/canvases/${encodeURIComponent(slug)}/name`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        },
      )
      if (res.ok) setNames((await res.json()) as WorkspaceNames)
    } catch {
      /* ignore */
    } finally {
      setRenamingCanvas(false)
      setDraft('')
    }
  }

  const cancelRename = () => {
    setRenamingCanvas(false)
    setDraft('')
  }

  // Toggle pin state and replace local state with the server response.
  // This intentionally avoids optimistic UI because rollback is not worth the added complexity.
  const togglePin = useCallback(
    async (targetSlug: string, pinned: boolean) => {
      try {
        const res = await apiFetch(
          `/api/workspaces/${workspaceId}/canvases/${encodeURIComponent(targetSlug)}/pin`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pinned }),
          },
        )
        if (res.ok) setNames((await res.json()) as WorkspaceNames)
      } catch {
        /* Pin failures stay silent; the UX does not need explicit retry handling here. */
      }
    },
    [workspaceId],
  )

  // ---- canvas switcher data ----
  const sortedCanvases = useMemo(
    () => [...canvases].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
    [canvases],
  )
  const filteredCanvases = useMemo(() => {
    const q = canvasSearch.trim().toLowerCase()
    if (!q) return sortedCanvases
    return sortedCanvases.filter((c) => {
      const n = names.canvases[c.slug]
      return c.slug.toLowerCase().includes(q) || (n?.toLowerCase().includes(q) ?? false)
    })
  }, [sortedCanvases, canvasSearch, names.canvases])

  // Split canvases into pinned and regular sections.
  // Preserve the user-defined order in names.pinned instead of resorting those items by recency.
  const pinnedSet = useMemo(() => new Set(names.pinned), [names.pinned])
  const pinnedCanvases = useMemo(() => {
    const bySlug = new Map(filteredCanvases.map((c) => [c.slug, c]))
    return names.pinned.map((s) => bySlug.get(s)).filter((c): c is CanvasInfo => !!c)
  }, [filteredCanvases, names.pinned])

  // Group by slug prefix (the first segment). Canvases without "/" stay in the ungrouped bucket.
  // Preserve recency order within each group and exclude anything already shown in the pinned section.
  const groupedCanvases = useMemo(() => {
    const groups = new Map<string, CanvasInfo[]>()
    const UNGROUPED = ''
    for (const c of filteredCanvases) {
      if (pinnedSet.has(c.slug)) continue
      const ix = c.slug.indexOf('/')
      const key = ix === -1 ? UNGROUPED : c.slug.slice(0, ix)
      const arr = groups.get(key)
      if (arr) arr.push(c)
      else groups.set(key, [c])
    }
    // Sort group headers alphabetically, but keep the ungrouped bucket last.
    return [...groups.entries()].sort(([a], [b]) => {
      if (a === UNGROUPED) return 1
      if (b === UNGROUPED) return -1
      return a.localeCompare(b)
    })
  }, [filteredCanvases, pinnedSet])

  const canvasCustomName = names.canvases[slug]
  // Prefer the custom name when present; otherwise split the slug into prefix and leaf.
  // Muting the prefix helps show that nearby canvases belong to the same group.
  const slashIndex = slug.indexOf('/')
  const canvasPrefix = !canvasCustomName && slashIndex !== -1 ? slug.slice(0, slashIndex) : null
  const canvasLeaf = !canvasCustomName && slashIndex !== -1 ? slug.slice(slashIndex + 1) : null
  const canvasFlat = canvasCustomName ?? (canvasPrefix === null ? slug : null)

  // Close the version history popover on outside clicks.
  useEffect(() => {
    if (!versionOpen) return
    const onClick = (e: MouseEvent) => {
      const panel = versionPanelRef.current
      if (!panel) return
      const target = e.target as Node | null
      if (target && !panel.contains(target)) {
        // Ignore clicks on the trigger itself because the toggle button handles those.
        const isTrigger = (e.target as HTMLElement)?.closest('[data-version-trigger]')
        if (!isTrigger) setVersionOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [versionOpen])

  // New canvas flow: open dialog, enter slug, POST /canvases, then navigate on success.
  // Reusing the current prefix makes it easier to keep related canvases grouped.
  const openNewCanvas = () => {
    const ix = slug.indexOf('/')
    const prefix = ix !== -1 ? slug.slice(0, ix) + '/' : ''
    setNewCanvasSlug(prefix)
    setNewCanvasError(null)
    setNewCanvasOpen(true)
  }

  const submitNewCanvas = async () => {
    const target = newCanvasSlug.trim()
    if (!target || target.endsWith('/')) {
      setNewCanvasError('Enter a slug (e.g. "design/foo" or "quick-note").')
      return
    }
    setNewCanvasBusy(true)
    setNewCanvasError(null)
    try {
      const res = await apiFetch(`/api/workspaces/${workspaceId}/canvases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: target }),
      })
      if (res.ok) {
        setNewCanvasOpen(false)
        setNewCanvasSlug('')
        navigate(`/canvas/${workspaceId}/${encodeURIComponent(target)}`)
        return
      }
      const parsed = problemDetailsErrorSchema.safeParse(await res.json().catch(() => ({})))
      // Use the Problem Details title when present; otherwise show a safe
      // generic message. Never expose body.message or Error.message — those
      // can contain server-side paths or credentials (P-HTTP-005).
      const title = parsed.success ? parsed.data.title : undefined
      setNewCanvasError(title ? title : 'Failed to create canvas.')
    } catch {
      setNewCanvasError('Failed to create canvas.')
    } finally {
      setNewCanvasBusy(false)
    }
  }

  const copyCanvasUrl = async () => {
    try {
      const url = `${window.location.origin}/canvas/${workspaceId}/${encodeURIComponent(slug)}`
      await navigator.clipboard.writeText(url)
    } catch {
      /* ignore */
    }
  }

  return (
    <header className="relative z-30 flex h-12 shrink-0 items-center justify-between gap-3 border-b bg-background px-3">
      {/* Left side: back button, workspace name, and canvas switcher. */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              to="/"
              className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ChevronLeft className="size-4" />
            </Link>
          </TooltipTrigger>
          <TooltipContent>Back to canvas list</TooltipContent>
        </Tooltip>

        {/* canvas switcher dropdown — workspace identity is intentionally
            hidden in OSS Local; the back-button returns to the flat canvas
            list and the name shown here is the canvas, not the workspace. */}
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
                  onChange={(e) => setCanvasSearch(e.target.value)}
                  placeholder="Switch canvas…"
                  className="h-8 pl-7 text-xs"
                  autoFocus
                />
              </div>
            </div>
            <div>
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
                            customName={names.canvases[c.slug]}
                            // Keep the full slug in the pinned section so the original group context stays visible.
                            leafLabel={names.canvases[c.slug] ?? c.slug}
                            active={c.slug === slug}
                            pinned={true}
                            onNavigate={() => {
                              navigate(`/canvas/${workspaceId}/${encodeURIComponent(c.slug)}`)
                              setCanvasSearch('')
                            }}
                            onTogglePin={togglePin}
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
                              customName={names.canvases[c.slug]}
                              leafLabel={names.canvases[c.slug] ?? leafSlug}
                              active={c.slug === slug}
                              pinned={false}
                              onNavigate={() => {
                                navigate(`/canvas/${workspaceId}/${encodeURIComponent(c.slug)}`)
                                setCanvasSearch('')
                              }}
                              onTogglePin={togglePin}
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
                onSelect={openNewCanvas}
                className="gap-2 rounded-none font-medium"
              >
                <FilePlus2 className="size-3.5" />
                New canvas…
              </DropdownMenuItem>
            </div>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Canvas-specific actions such as rename and copy URL. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Canvas actions"
            >
              <Pencil className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem
              onSelect={() => {
                setDraft(names.canvases[slug] ?? '')
                setRenamingCanvas(true)
              }}
              className="gap-2"
            >
              <Pencil className="size-3.5" />
              Rename canvas
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={copyCanvasUrl} className="gap-2">
              <Copy className="size-3.5" />
              Copy canvas URL
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Inline canvas rename input. */}
        {renamingCanvas && (
          <Input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitCanvasName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitCanvasName()
              else if (e.key === 'Escape') cancelRename()
            }}
            placeholder={slug}
            className="h-7 max-w-[220px] text-sm"
          />
        )}

        {/* Branch chip with switch, create, rename, delete, and merge actions. */}
        <span className="mx-1 hidden h-4 w-px bg-border sm:inline-block" aria-hidden />
        <HeaderBranchChip workspaceId={workspaceId} slug={slug} />

        {/* Save-state dot. */}
        <HeaderSaveDot
          dirty={isDirty}
          saving={saving}
          onSave={() => void saveVersion('')}
          shortcutHint={shortcutHint}
        />
      </div>

      {/* Right side: version history and fullscreen. */}
      <div className="flex shrink-0 items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              data-version-trigger
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => setVersionOpen((v) => !v)}
            >
              <History className="size-3.5" />
              <span className="text-xs">History</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Version history</TooltipContent>
        </Tooltip>
        {onToggleTheme && theme && <ThemeToggleButton theme={theme} onChange={onToggleTheme} />}
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
      </div>

      <Dialog open={newCanvasOpen} onOpenChange={setNewCanvasOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New canvas</DialogTitle>
            <DialogDescription>
              Slug identifies the canvas on disk. Use `/` to group (e.g. "design/login-flow").
              Allowed: letters, digits, `-`, `/` (no leading/trailing `/`).
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={newCanvasSlug}
            onChange={(e) => {
              setNewCanvasSlug(e.target.value)
              if (newCanvasError) setNewCanvasError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void submitNewCanvas()
              }
            }}
            placeholder="e.g. design/login-flow"
            maxLength={120}
          />
          {newCanvasError && <div className="text-xs text-destructive">{newCanvasError}</div>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewCanvasOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submitNewCanvas} disabled={newCanvasBusy}>
              {newCanvasBusy ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Version history popover docked under the top-right controls. */}
      {versionOpen && (
        <div
          ref={versionPanelRef}
          className="absolute right-3 top-[calc(100%+6px)] z-40 w-[340px] overflow-hidden rounded-lg border bg-background shadow-lg"
        >
          <div className="flex h-[480px] min-h-0 flex-col">
            <VersionTimeline workspaceId={workspaceId} slug={slug} onRestored={onRestored} />
          </div>
        </div>
      )}
    </header>
  )
}
