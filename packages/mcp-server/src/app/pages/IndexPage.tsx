import React, { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Search, Radio, RadioTower, FileStack } from 'lucide-react'

import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { apiFetch } from '../lib/api-client.js'

interface RawWorkspace {
  workspaceId: string
  daemonAlive: boolean
  canvases: { slug: string; updatedAt: string }[]
}

interface WorkspaceNames {
  workspace?: string
  canvases: Record<string, string>
}

interface EnrichedWorkspace extends RawWorkspace {
  names: WorkspaceNames
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const diff = Math.floor((Date.now() - t) / 1000)
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function filterWorkspaces(
  workspaces: EnrichedWorkspace[],
  activeOnly: boolean,
  search: string,
): EnrichedWorkspace[] {
  const needle = search.trim().toLowerCase()
  return workspaces
    .filter((s) => (activeOnly ? s.daemonAlive : true))
    .map((s) => {
      if (!needle) return s
      const filtered = s.canvases.filter((c) => {
        const name = s.names.canvases[c.slug] ?? c.slug
        return (
          name.toLowerCase().includes(needle) ||
          c.slug.toLowerCase().includes(needle) ||
          (s.names.workspace ?? '').toLowerCase().includes(needle)
        )
      })
      return { ...s, canvases: filtered }
    })
    .filter((s) => (needle ? s.canvases.length > 0 : true))
}

export default function IndexPage() {
  const [workspaces, setWorkspaces] = useState<EnrichedWorkspace[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeOnly, setActiveOnly] = useState(false)
  const [search, setSearch] = useState('')

  useEffect(() => {
    ;(async () => {
      try {
        const res = await apiFetch('/api/workspaces')
        const { workspaces: rawList } = (await res.json()) as {
          workspaces: { workspaceId: string; daemonAlive: boolean }[]
        }
        const enriched = await Promise.all(
          rawList.map(async (raw): Promise<EnrichedWorkspace> => {
            const id = raw.workspaceId
            const [canvasesRes, namesRes] = await Promise.all([
              apiFetch(`/api/workspaces/${id}/canvases`),
              apiFetch(`/api/workspaces/${id}/names`),
            ])
            const { canvases } = (await canvasesRes.json()) as {
              canvases: { slug: string; updatedAt: string }[]
            }
            const names: WorkspaceNames = namesRes.ok
              ? ((await namesRes.json()) as WorkspaceNames)
              : { canvases: {} }
            return { ...raw, canvases, names }
          }),
        )
        setWorkspaces(enriched)
      } catch (err) {
        setError(String(err))
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const visible = useMemo(
    () => filterWorkspaces(workspaces, activeOnly, search),
    [workspaces, activeOnly, search],
  )

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground">
        Loading workspaces…
      </div>
    )
  }
  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center text-destructive">
        Error: {error}
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-4xl px-6 py-8">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">Whiteboard</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Collaborative Excalidraw whiteboards for AI × human design alignment.
          </p>
        </header>

        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
            <Input
              type="search"
              placeholder="Filter by workspace or canvas name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer whitespace-nowrap">
            <input
              type="checkbox"
              checked={activeOnly}
              onChange={(e) => setActiveOnly(e.target.checked)}
              className="size-3.5"
            />
            Live daemon only
          </label>
        </div>

        {workspaces.length === 0 ? (
          <div className="rounded-lg border border-dashed p-12 text-center">
            <FileStack className="size-12 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">
              No workspaces yet.
              <br />
              Use the MCP tool{' '}
              <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">canvas_create</code> to make one.
            </p>
          </div>
        ) : visible.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            No workspaces match the current filter.
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {visible.map((workspace) => (
              <WorkspaceCard key={workspace.workspaceId} workspace={workspace} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// Show up to 8 canvases inline, then collapse the rest behind a "Show N more" toggle.
// This keeps cards naturally sized without letting long canvas lists dominate the page.
const INITIAL_CANVAS_LIMIT = 8

interface CollapsibleCanvasListProps {
  workspace: EnrichedWorkspace
  canvases: { slug: string; updatedAt: string }[]
}

function CollapsibleCanvasList({ workspace, canvases }: CollapsibleCanvasListProps) {
  const [expanded, setExpanded] = useState(false)
  const shown =
    expanded || canvases.length <= INITIAL_CANVAS_LIMIT
      ? canvases
      : canvases.slice(0, INITIAL_CANVAS_LIMIT)
  const hidden = canvases.length - shown.length
  return (
    <div className="flex flex-col gap-0.5">
      {shown.map((c) => {
        const displayName = workspace.names.canvases[c.slug] ?? c.slug
        const hasCustom = !!workspace.names.canvases[c.slug]
        return (
          <Link
            key={c.slug}
            to={`/canvas/${workspace.workspaceId}/${encodeURIComponent(c.slug)}`}
            className="group flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent transition-colors"
          >
            <div className="min-w-0">
              <div className="truncate font-medium">{displayName}</div>
              {hasCustom && (
                <div className="truncate font-mono text-[10px] text-muted-foreground">
                  {c.slug}
                </div>
              )}
            </div>
            <div className="shrink-0 text-[11px] text-muted-foreground">
              {formatRelative(c.updatedAt)}
            </div>
          </Link>
        )
      })}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-1 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground text-left"
        >
          Show {hidden} more…
        </button>
      )}
    </div>
  )
}

interface WorkspaceCardProps {
  workspace: EnrichedWorkspace
}

function WorkspaceCard({ workspace }: WorkspaceCardProps) {
  const name = workspace.names.workspace ?? 'Untitled workspace'
  const shortId = workspace.workspaceId.slice(0, 5) + '…' + workspace.workspaceId.slice(-3)
  const canvases = useMemo(
    () => [...workspace.canvases].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
    [workspace.canvases],
  )

  return (
    <Card>
      <CardContent className="px-5">
        <div className="flex items-center justify-between gap-2 mb-3">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-base font-semibold truncate">{name}</h2>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {shortId}
                </span>
              </TooltipTrigger>
              <TooltipContent>{workspace.workspaceId}</TooltipContent>
            </Tooltip>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={
                  workspace.daemonAlive
                    ? 'shrink-0 inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600'
                    : 'shrink-0 inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground'
                }
              >
                {workspace.daemonAlive ? (
                  <RadioTower className="size-3" />
                ) : (
                  <Radio className="size-3" />
                )}
                {workspace.daemonAlive ? 'daemon live' : 'daemon offline'}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {workspace.daemonAlive
                ? 'The local daemon for this workspace is currently running.'
                : 'The local daemon for this workspace is offline. Saved canvases remain available.'}
            </TooltipContent>
          </Tooltip>
        </div>

        {canvases.length === 0 ? (
          <p className="text-xs text-muted-foreground">No canvases.</p>
        ) : (
          // Let the card grow naturally instead of introducing nested scrolling here.
          // Collapse long lists and leave detailed browsing to the canvas page itself.
          <CollapsibleCanvasList workspace={workspace} canvases={canvases} />
        )}
      </CardContent>
    </Card>
  )
}
