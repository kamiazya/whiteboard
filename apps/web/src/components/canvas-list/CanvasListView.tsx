import type { CanvasKind } from '@kamiazya/whiteboard-canvas-model'
import { FileBox, FileText, Plus } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { filterCanvasesBySearch } from '../workspace-top-bar/canvas-list.js'

export interface CanvasListRow {
  slug: string
  displayName: string
  // The muted second line: the daemon page passes the slug, browser-local
  // passes the derived display slug — the same visual slot either way.
  secondary?: string
  updatedAt: string
  kind: CanvasKind
}

// Clock drift between client and daemon can make (now - t) negative; clamp
// so the label never reads "-5s ago".
export function formatRelative(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const diff = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

export interface CanvasListViewProps {
  rows: readonly CanvasListRow[]
  onOpen: (slug: string) => void
  // Immediate create per ADR-0006: no name is collected up front. The menu
  // picks which CanvasKind the caller creates; everything else about the
  // creation (slug derivation, the POST) is the caller's.
  onCreate: (kind: CanvasKind) => void
  // Capability slot: the daemon page passes CanvasThumb; browser-local omits
  // it and gets the label-only card. A render prop, NOT a scene render —
  // this component never imports canvas-render/canvas-viewer.
  renderThumb?: (row: CanvasListRow) => ReactNode
  // Per-card actions overlay (daemon: Duplicate; S8 adds Delete). Rendered as
  // a sibling of the open-button so its own buttons manage stopPropagation.
  renderActions?: (row: CanvasListRow) => ReactNode
  // Disables the create affordances while a create is in flight — the caller
  // owns the busy state because it owns the POST.
  createDisabled?: boolean
}

// The shared, capability-gated canvas list that both the daemon and the
// browser-local pages render. Purely presentational: rows in, callbacks
// out — no daemon client, no zod, so the browser-local chunk never pays
// for the daemon's dependencies.
export function CanvasListView({
  rows,
  onOpen,
  onCreate,
  renderThumb,
  renderActions,
  createDisabled,
}: CanvasListViewProps) {
  const [search, setSearch] = useState('')

  // Caller order is the contract — the daemon page sorts pinned-first, the
  // browser-local page sorts by recency, and a component-side re-sort would
  // silently discard whichever policy the caller chose.
  const visible = useMemo(() => {
    const infos = rows.map((r) => ({ slug: r.slug, updatedAt: r.updatedAt, name: r.displayName }))
    const names = Object.fromEntries(rows.map((r) => [r.slug, r.displayName]))
    const filtered = filterCanvasesBySearch(infos, search, names)
    const bySlug = new Map(rows.map((r) => [r.slug, r]))
    return filtered.map((c) => bySlug.get(c.slug)).filter((r): r is CanvasListRow => !!r)
  }, [rows, search])

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <p className="text-sm font-medium">No canvases yet</p>
        <p className="text-sm text-muted-foreground">Create a canvas and it opens ready to draw.</p>
        <button
          type="button"
          disabled={createDisabled}
          onClick={() => onCreate('spatial')}
          className="rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
        >
          Create a canvas
        </button>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex items-center gap-2">
        <input
          type="search"
          aria-label="Search canvases"
          placeholder="Search canvases…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="rounded-md border bg-background px-2 py-1 text-sm"
        />
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="New canvas"
                  disabled={createDisabled}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <Plus aria-hidden="true" className="size-4" />
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>New canvas</TooltipContent>
          </Tooltip>
          {/* A menu is a reading surface: icon AND label (ADR-0006 point 4).
              Items are disabled alongside the trigger: a menu opened BEFORE a
              create started stays open while it runs, so the items are a
              second live path to a double-create the trigger's own disabled
              attribute cannot cover. */}
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              className="gap-2"
              disabled={createDisabled}
              onSelect={() => onCreate('spatial')}
            >
              <FileBox aria-hidden="true" className="size-3.5" />
              New canvas
            </DropdownMenuItem>
            <DropdownMenuItem
              className="gap-2"
              disabled={createDisabled}
              onSelect={() => onCreate('markdown')}
            >
              <FileText aria-hidden="true" className="size-3.5" />
              New markdown note
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">No canvases match.</p>
      ) : null}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {visible.map((row) => (
          // biome-ignore lint/a11y/noStaticElementInteractions: enlarges the click target only; the nested <button> below already provides keyboard access to the same action
          // biome-ignore lint/a11y/useKeyWithClickEvents: enlarges the click target only; the nested <button> below already provides keyboard access to the same action
          <div
            key={row.slug}
            data-testid="canvas-list-card"
            onClick={() => onOpen(row.slug)}
            className="group relative rounded-lg border hover:bg-accent"
          >
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onOpen(row.slug)
              }}
              className="flex w-full flex-col gap-2 p-2 text-left"
            >
              {renderThumb?.(row)}
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{row.displayName}</div>
                {row.secondary !== undefined && (
                  <div
                    data-testid="canvas-secondary"
                    className="truncate text-xs text-muted-foreground"
                  >
                    {row.secondary}
                  </div>
                )}
                <div className="text-xs text-muted-foreground">
                  {row.kind === 'markdown' && <span className="mr-1">markdown ·</span>}
                  {formatRelative(row.updatedAt)}
                </div>
              </div>
            </button>
            {renderActions?.(row)}
          </div>
        ))}
      </div>
    </div>
  )
}
