import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { MoreHorizontal, Pin, Plus, Search } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { CanvasThumb } from '../components/CanvasThumb.js'
import { StorageReportCard } from '../components/StorageReportCard.js'
import { ThemeToggleButton } from '../components/ThemeToggleButton.js'
import { useThemeMode } from '../hooks/useThemeMode.js'
import { formatBytes } from '../lib/format-bytes.js'
import {
  listCanvasesResponseSchema,
  listWorkspacesResponseSchema,
  problemDetailsErrorSchema,
  workspaceNamesSchema,
  type WorkspaceNames,
} from '../../shared/api-contracts/canvas.js'
import { apiFetch } from '../lib/api-client.js'

// IndexPage is canvas-first in OSS Local mode. Workspace identity is still
// in the data model (FKs, paths, future SaaS multi-tenancy) but is not
// surfaced in the UI: users see one flat list of canvases sorted by pin /
// freshness, regardless of which internal workspace they belong to.
//
// Click-through still navigates to `/canvas/{workspaceId}/{slug}` so the
// daemon resolves the right blob. The workspaceId travels in the URL —
// nothing user-facing names it as a "workspace".

interface RawWorkspace {
  workspaceId: string
}

interface RawCanvas {
  slug: string
  updatedAt: string
}

interface FlatCanvas {
  workspaceId: string
  slug: string
  // Custom display name from /api/workspaces/:id/names, falling back to slug.
  displayName: string
  // Whether displayName came from a custom name (drives the slug subtitle).
  hasCustomName: boolean
  updatedAt: string
  pinned: boolean
  // Index inside the workspace's `pinned: string[]`. Lower = pinned earlier
  // (rendered closer to the top). Number.POSITIVE_INFINITY for unpinned.
  pinOrder: number
}

type TabKey = 'canvases' | 'storage'

// localStorage key for the implicit primary workspace id. Survives
// remount so a freshly-minted workspace is reused across the
// post-create navigate → user-comes-back flow instead of being
// re-minted on every open.
const PRIMARY_WORKSPACE_KEY = 'whiteboard.indexPage.primaryWorkspaceId'

// localStorage is shared across pages and writable from the dev
// console, so the read-back value cannot be trusted blindly. Mirrors
// the server-side `validateWorkspaceId` shape so an attacker-supplied
// stash containing path separators can NOT flow into the create POST
// URL or the post-create navigate.
const WORKSPACE_ID_RE = /^[A-Za-z0-9_-]+$/

function readTabFromHash(): TabKey {
  if (typeof window === 'undefined') return 'canvases'
  const h = window.location.hash.replace(/^#/, '')
  return h === 'storage' ? 'storage' : 'canvases'
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

function filterCanvases(canvases: FlatCanvas[], search: string): FlatCanvas[] {
  const needle = search.trim().toLowerCase()
  if (!needle) return canvases
  return canvases.filter(
    (c) => c.displayName.toLowerCase().includes(needle) || c.slug.toLowerCase().includes(needle),
  )
}

function sortCanvases(canvases: FlatCanvas[]): FlatCanvas[] {
  // Pinned canvases stay at the top in their user-defined per-workspace
  // order. Unpinned canvases follow in updatedAt desc. We do NOT cross-sort
  // pin order between workspaces: each workspace's pinned[] is its own
  // ranking. The grid simply concatenates pinned-first across workspaces in
  // a stable order (insertion order from /api/workspaces).
  return [...canvases].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    if (a.pinned && b.pinned) {
      if (a.workspaceId !== b.workspaceId) {
        return a.workspaceId < b.workspaceId ? -1 : 1
      }
      return a.pinOrder - b.pinOrder
    }
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1
    return 0
  })
}

export default function IndexPage() {
  const [canvases, setCanvases] = useState<FlatCanvas[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  // The first workspace from /api/workspaces is the implicit "current"
  // workspace for new-canvas creation. Workspace identity stays internal —
  // the user never names it — but creates need *some* target id.
  //
  // Persist the chosen id in localStorage so a freshly-minted workspace
  // (no pre-existing /api/workspaces entry) is still reused on the next
  // create after the user navigates between pages. Without this every
  // sequential create from a cold-start install would mint its own
  // throwaway workspace.
  const [primaryWorkspaceId, setPrimaryWorkspaceId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    try {
      const stored = window.localStorage.getItem(PRIMARY_WORKSPACE_KEY)
      return stored && WORKSPACE_ID_RE.test(stored) ? stored : null
    } catch {
      return null
    }
  })
  const rememberPrimaryWorkspace = useCallback((id: string) => {
    if (!WORKSPACE_ID_RE.test(id)) return
    setPrimaryWorkspaceId(id)
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(PRIMARY_WORKSPACE_KEY, id)
    } catch {
      // Storage failures are not user-facing — falling back to in-memory
      // state is still better than minting a new workspace per click.
    }
  }, [])
  // Theme toggle lives in the IndexPage header so users do not have to open a
  // canvas to flip light/dark/system.
  const { theme, setTheme } = useThemeMode()
  const navigate = useNavigate()
  // Dialog state lives at the page level so the in-grid tile and the empty
  // state share one trigger — there is only ever one creation flow open.
  const [createOpen, setCreateOpen] = useState(false)
  // Tab state. We persist via the URL hash (`#canvases` / `#storage`) so a
  // bookmark / reload returns the user to the same view, and so the URL
  // makes which view is active obvious. `cn()`-equivalent for the panel
  // attribute happens via a hidden flag below.
  const [activeTab, setActiveTab] = useState<TabKey>(() => readTabFromHash())
  useEffect(() => {
    if (typeof window === 'undefined') return
    const desired = `#${activeTab}`
    if (window.location.hash !== desired) {
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${desired}`)
    }
  }, [activeTab])

  useEffect(() => {
    ;(async () => {
      try {
        const res = await apiFetch('/api/workspaces')
        const workspaces = listWorkspacesResponseSchema.parse(await res.json()).workspaces
        // Prefer the server's first workspace when present; otherwise leave
        // whatever was rehydrated from localStorage in place so a minted
        // id from an earlier session survives until the server catches up.
        if (workspaces[0]?.workspaceId) rememberPrimaryWorkspace(workspaces[0].workspaceId)
        const perWorkspace = await Promise.all(
          workspaces.map(async (ws: RawWorkspace): Promise<FlatCanvas[]> => {
            const id = ws.workspaceId
            const [canvasesRes, namesRes] = await Promise.all([
              apiFetch(`/api/workspaces/${id}/canvases`),
              apiFetch(`/api/workspaces/${id}/names`),
            ])
            const { canvases: rawCanvases } = listCanvasesResponseSchema.parse(
              await canvasesRes.json(),
            )
            const names: WorkspaceNames = namesRes.ok
              ? workspaceNamesSchema.parse(await namesRes.json())
              : { canvases: {}, pinned: [] }
            const pinIndex = new Map<string, number>()
            names.pinned.forEach((slug, i) => pinIndex.set(slug, i))
            return rawCanvases.map((c: RawCanvas) => {
              const customName = names.canvases[c.slug]
              const pinOrder = pinIndex.get(c.slug)
              return {
                workspaceId: id,
                slug: c.slug,
                displayName: customName ?? c.slug,
                hasCustomName: !!customName,
                updatedAt: c.updatedAt,
                pinned: pinOrder !== undefined,
                pinOrder: pinOrder ?? Number.POSITIVE_INFINITY,
              }
            })
          }),
        )
        setCanvases(sortCanvases(perWorkspace.flat()))
      } catch (err) {
        setError(String(err))
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const visible = useMemo(() => filterCanvases(canvases, search), [canvases, search])

  // Pin toggle hits the same PUT route the WorkspaceTopBar uses; the server
  // returns the refreshed WorkspaceNames so we re-derive pin state for that
  // workspace's canvases without re-fetching everything.
  const togglePin = useCallback(
    async (workspaceId: string, slug: string, pinned: boolean): Promise<void> => {
      try {
        const res = await apiFetch(
          `/api/workspaces/${workspaceId}/canvases/${encodeURIComponent(slug)}/pin`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pinned }),
          },
        )
        if (!res.ok) return
        const next = workspaceNamesSchema.parse(await res.json())
        const pinIndex = new Map<string, number>()
        next.pinned.forEach((s, i) => pinIndex.set(s, i))
        setCanvases((prev) =>
          sortCanvases(
            prev.map((c) => {
              if (c.workspaceId !== workspaceId) return c
              const pinOrder = pinIndex.get(c.slug)
              return {
                ...c,
                pinned: pinOrder !== undefined,
                pinOrder: pinOrder ?? Number.POSITIVE_INFINITY,
              }
            }),
          ),
        )
      } catch {
        /* Silent failure matches the canvas switcher's UX. */
      }
    },
    [],
  )

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground">
        Loading canvases…
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
      <div className="mx-auto max-w-4xl px-6 py-8 space-y-10">
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">Whiteboard</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Collaborative Excalidraw whiteboards for AI × human design alignment.
            </p>
          </div>
          <div className="shrink-0 pt-1">
            <ThemeToggleButton theme={theme} onChange={setTheme} />
          </div>
        </header>

        {/* Tabs split the page into two concerns the user thinks about
            separately: canvases (the primary object collection they create
            and open) vs. storage (meta/admin info about disk usage). The
            active tab is mirrored in the URL hash so reload / share lands
            on the same view. */}
        <div className="space-y-4">
          <div role="tablist" aria-label="Whiteboard sections" className="flex border-b">
            <TabButton
              active={activeTab === 'canvases'}
              onSelect={() => setActiveTab('canvases')}
              id="tab-canvases"
              controls="panel-canvases"
            >
              Canvases
            </TabButton>
            <TabButton
              active={activeTab === 'storage'}
              onSelect={() => setActiveTab('storage')}
              id="tab-storage"
              controls="panel-storage"
            >
              Storage
            </TabButton>
          </div>

          <div
            role="tabpanel"
            id="panel-canvases"
            aria-labelledby="tab-canvases"
            hidden={activeTab !== 'canvases'}
            className="space-y-4"
          >
            <div className="flex items-center justify-end">
              <div className="relative w-full max-w-xs">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
                <Input
                  type="search"
                  placeholder="Filter by canvas name…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9 h-8 text-sm"
                />
              </div>
            </div>

            {/* The new-canvas tile sits *inside* the canvas collection so the
                create affordance is visually a peer of the existing canvases
                — OOUI-style: act on the object collection, not via a global
                action button. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <NewCanvasTile onClick={() => setCreateOpen(true)} />
              {visible.map((canvas) => (
                <CanvasCard
                  key={`${canvas.workspaceId}/${canvas.slug}`}
                  canvas={canvas}
                  onTogglePin={togglePin}
                />
              ))}
            </div>
            {canvases.length > 0 && visible.length === 0 && (
              <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                No canvases match the current filter.
              </div>
            )}
          </div>

          <div
            role="tabpanel"
            id="panel-storage"
            aria-labelledby="tab-storage"
            hidden={activeTab !== 'storage'}
            className="space-y-3"
          >
            <StorageReportCard />
          </div>
        </div>
      </div>

      <NewCanvasDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        workspaceId={primaryWorkspaceId}
        onCreated={(targetWs, path) => {
          // Capture the (possibly freshly-minted) workspace id back into
          // shared state + localStorage so a second create from the same
          // session reuses it. Without this, every cold-start create
          // spawns its own throwaway workspace.
          rememberPrimaryWorkspace(targetWs)
          navigate(path)
        }}
      />
    </div>
  )
}

function CanvasCard({
  canvas,
  onTogglePin,
}: {
  canvas: FlatCanvas
  onTogglePin: (workspaceId: string, slug: string, pinned: boolean) => Promise<void>
}) {
  // Transient feedback for the "Optimize" menu action. Replaces the
  // updated-at time briefly so the user can tell the action ran without a
  // separate toast component. null = no transient state shown.
  const [optimizeStatus, setOptimizeStatus] = useState<string | null>(null)

  const optimize = useCallback(async () => {
    setOptimizeStatus('Optimizing…')
    try {
      const res = await apiFetch(
        `/api/workspaces/${canvas.workspaceId}/canvases/${encodeURIComponent(canvas.slug)}/compact`,
        { method: 'POST' },
      )
      if (!res.ok) {
        setOptimizeStatus('Optimize failed')
      } else {
        const body = (await res.json()) as {
          compacted: boolean
          beforeBytes: number
          afterBytes: number
          reason?: string
        }
        const delta = body.beforeBytes - body.afterBytes
        setOptimizeStatus(
          body.compacted && delta > 0 ? `Saved ${formatBytes(delta)}` : 'Already optimal',
        )
      }
    } catch {
      setOptimizeStatus('Optimize failed')
    } finally {
      window.setTimeout(() => setOptimizeStatus(null), 3000)
    }
  }, [canvas.workspaceId, canvas.slug])

  return (
    <Link
      to={`/canvas/${canvas.workspaceId}/${encodeURIComponent(canvas.slug)}`}
      className="group focus:outline-none"
    >
      <Card className="relative overflow-hidden transition-colors group-hover:border-foreground/20 group-hover:shadow-sm">
        {/* Pin toggle. Anchored top-right; hidden until hover when not
            pinned so it does not visually compete with thumbnails on a
            cold page. Stop propagation + preventDefault so the click
            never bubbles into the surrounding Link navigation. */}
        <button
          type="button"
          aria-label={`${canvas.pinned ? 'Unpin' : 'Pin'} canvas: ${canvas.slug}`}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            void onTogglePin(canvas.workspaceId, canvas.slug, !canvas.pinned)
          }}
          className={cn(
            'absolute right-2 top-2 z-10 rounded-full p-1.5 backdrop-blur transition-opacity',
            'bg-background/80 text-muted-foreground hover:bg-background hover:text-foreground',
            canvas.pinned ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100',
          )}
        >
          <Pin className={cn('size-3.5', canvas.pinned && 'fill-current text-foreground')} />
        </button>

        {/* Per-card actions kebab. Sits left of Pin so both stay reachable
            in the same hover band. Only Optimize lives here today; future
            per-canvas object actions (Cleanup files, Delete canvas, …) land
            in the same menu. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Canvas actions: ${canvas.slug}`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
              }}
              className="absolute right-9 top-2 z-10 rounded-full bg-background/80 p-1.5 text-muted-foreground opacity-0 backdrop-blur transition-opacity hover:bg-background hover:text-foreground group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100"
            >
              <MoreHorizontal className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            // Stop the menu's pointer / keyboard interactions from
            // bubbling into the surrounding Link.
            onCloseAutoFocus={(e) => e.preventDefault()}
            onClick={(e) => e.stopPropagation()}
          >
            <DropdownMenuItem
              onSelect={() => {
                void optimize()
              }}
              // React synthetic events bubble through the React tree, not
              // the DOM tree — even though Radix portals the menu out of
              // the surrounding <Link>, the click still propagates back up
              // the React parent chain and would navigate. stopPropagation
              // here keeps the click in the menu.
              onClick={(e) => {
                e.stopPropagation()
              }}
            >
              Optimize
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <CanvasThumb
          workspaceId={canvas.workspaceId}
          slug={canvas.slug}
          size="card"
          className="rounded-none border-0 border-b"
        />
        <CardContent className="px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{canvas.displayName}</div>
              {canvas.hasCustomName && (
                <div className="truncate font-mono text-[10px] text-muted-foreground">
                  {canvas.slug}
                </div>
              )}
            </div>
            <div className="shrink-0 text-[11px] text-muted-foreground">
              {optimizeStatus ?? formatRelative(canvas.updatedAt)}
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  )
}

// Mints a workspace-shaped id without pulling nanoid into the bundle. The
// server only requires `[A-Za-z0-9_-]+`, which UUID v4 (sans dashes) trivially
// satisfies. Used only when the user opens a fresh install with no workspace.
function mintWorkspaceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '')
  }
  return `ws_${Date.now()}_${Math.floor(Math.random() * 1e9)}`
}

// Dashed in-grid tile that visually parallels the existing canvas cards.
// Clicking opens the shared NewCanvasDialog. Kept as the first cell of the
// grid so the create affordance is a peer of the canvases the user is
// scanning, not a separate global action.
function NewCanvasTile({ onClick }: { onClick: () => void }) {
  // Mirrors CanvasCard's exact layout — dashed Card wrapper, 16:9 thumb-shaped
  // top region with the Plus icon (matching CanvasThumb size="card"), and a
  // CardContent footer with "New canvas" aligned to the same baseline as the
  // existing canvas titles. Same outer height as the real cards keeps the
  // grid visually flush.
  return (
    <button
      type="button"
      aria-label="New canvas"
      onClick={onClick}
      className="group block w-full text-left rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Card className="relative overflow-hidden border-2 border-dashed border-muted-foreground/30 bg-muted/10 transition-colors group-hover:border-foreground/40 group-hover:bg-muted/30 group-hover:shadow-sm">
        <div className="flex aspect-[16/9] w-full items-center justify-center border-b bg-muted/30 text-muted-foreground/60 transition-colors group-hover:text-foreground">
          <Plus className="size-8" />
        </div>
        <CardContent className="px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">New canvas</div>
            </div>
          </div>
        </CardContent>
      </Card>
    </button>
  )
}

function NewCanvasDialog({
  open,
  onOpenChange,
  workspaceId,
  onCreated,
}: {
  open: boolean
  onOpenChange: (next: boolean) => void
  workspaceId: string | null
  // Receives both the (possibly freshly-minted) workspace id and the
  // canvas path so the parent can persist the id and run the navigate.
  onCreated: (workspaceId: string, path: string) => void
}) {
  const [slug, setSlug] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      const value = slug.trim()
      if (!value) {
        setErrorMsg('Slug is required.')
        return
      }
      const targetWs = workspaceId ?? mintWorkspaceId()
      setSubmitting(true)
      setErrorMsg(null)
      try {
        const res = await apiFetch(`/api/workspaces/${targetWs}/canvases`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug: value }),
        })
        if (!res.ok) {
          if (res.status === 401) {
            // Authentication failure — the daemon requires a bearer token.
            // Do not leak token values or internal ports; give actionable guidance.
            setErrorMsg(
              'Canvas creation failed — authentication required. Ensure the daemon is running and your session token is valid.',
            )
            return
          }
          // For all other errors, use the RFC 9457 Problem Details title when
          // present; otherwise show a safe generic message (P-HTTP-005).
          const parsed = problemDetailsErrorSchema.safeParse(await res.json().catch(() => ({})))
          const title = parsed.success ? parsed.data.title : undefined
          setErrorMsg(title ?? `Create failed (${res.status}).`)
          return
        }
        onOpenChange(false)
        setSlug('')
        onCreated(targetWs, `/canvas/${targetWs}/${encodeURIComponent(value)}`)
      } catch (err) {
        setErrorMsg(String(err))
      } finally {
        setSubmitting(false)
      }
    },
    [slug, workspaceId, onCreated, onOpenChange],
  )

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) {
          setSlug('')
          setErrorMsg(null)
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New canvas</DialogTitle>
          <DialogDescription>
            Slug becomes the canvas's URL identifier. Lowercase letters, digits, and hyphens;{' '}
            <code>/</code> is allowed for grouping (e.g. <code>design/login</code>).
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="new-canvas-slug" className="text-xs font-medium">
              Slug
            </label>
            <Input
              id="new-canvas-slug"
              autoFocus
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="design/login"
              disabled={submitting}
            />
            {errorMsg && <p className="text-xs text-destructive">{errorMsg}</p>}
          </div>
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// Minimal tab trigger. Inline rather than a shared component because IndexPage
// is the only consumer right now — promote later if a second view needs the
// same chrome.
function TabButton({
  active,
  onSelect,
  id,
  controls,
  children,
}: {
  active: boolean
  onSelect: () => void
  id: string
  controls: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="tab"
      id={id}
      aria-controls={controls}
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      onClick={onSelect}
      className={cn(
        '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
        active
          ? 'border-foreground text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}
