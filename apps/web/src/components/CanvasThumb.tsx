import { FileText } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useDaemonApi, useHasDaemonApi } from '@/contexts/DaemonApiContext'
import { cn } from '@/lib/utils'

// Latest-thumbnail surface for a canvas.
//
// The route is the same daemon endpoint that hydrates the canvas switcher in
// WorkspaceTopBar, so this component is shared across IndexPage (grid card)
// and the dropdown (small inline). Each instance owns its own loading state
// — there is no shared cache; the browser HTTP cache handles repeats.
//
// `size` controls the rendered footprint without changing the request URL.
// `dropdown` matches the original 56×36 inline thumbnail in the canvas
// switcher; `card` is the larger 16:9 card preview used on IndexPage.

interface CanvasThumbProps {
  workspaceId: string
  slug: string
  size?: 'dropdown' | 'card'
  className?: string
}

export function CanvasThumb({ workspaceId, slug, size = 'dropdown', className }: CanvasThumbProps) {
  // A plain <img src> cannot carry the daemon's own origin or Authorization
  // bearer header, so a cross-origin daemon (a DaemonApiContext provider
  // mounted) fetches the image bytes through that authorized fetch and
  // renders them via an object URL instead — mirroring VersionThumbnail's
  // fetch-and-blob treatment.
  const hasDaemonApi = useHasDaemonApi()
  const daemonFetch = useDaemonApi()
  const [failed, setFailed] = useState(false)
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const src = `/api/workspaces/${encodeURIComponent(workspaceId)}/canvases/${encodeURIComponent(slug)}/latest-thumbnail`
  // Instances are reused across re-renders with a new slug/workspaceId (e.g.
  // the canvas switcher dropdown), so a stale `failed` flag from a previous
  // src must not leak into the next canvas's thumbnail. Reset during render
  // (not in an effect) so the fallback icon never flashes for one frame.
  const [prevSrc, setPrevSrc] = useState(src)
  if (prevSrc !== src) {
    setPrevSrc(src)
    setFailed(false)
    setObjectUrl(null)
  }

  useEffect(() => {
    if (!hasDaemonApi) return
    let cancelled = false
    let createdUrl: string | null = null

    async function load(): Promise<void> {
      try {
        const res = await daemonFetch(src)
        if (!res.ok) {
          if (!cancelled) setFailed(true)
          return
        }
        const blob = await res.blob()
        if (cancelled) return
        // "No thumbnail yet" arrives as 204 No Content — a success status, so
        // the `res.ok` check above lets it through. An object URL built from
        // that empty body renders as a broken image rather than degrading to
        // the placeholder, because a blob-backed <img> has no src to fail on.
        if (blob.size === 0) {
          setFailed(true)
          return
        }
        createdUrl = URL.createObjectURL(blob)
        setObjectUrl(createdUrl)
      } catch {
        if (!cancelled) setFailed(true)
      }
    }

    void load()
    return () => {
      cancelled = true
      if (createdUrl) URL.revokeObjectURL(createdUrl)
    }
    // daemonFetch is stable per provider identity, so including it does not
    // refetch per render — and a genuinely new fetch identity (base URL or
    // token change) must refetch rather than reuse stale credentials.
  }, [src, hasDaemonApi, daemonFetch])

  const wrapperClasses =
    size === 'card'
      ? 'flex aspect-[16/9] w-full items-center justify-center overflow-hidden rounded-md border bg-muted/40'
      : 'flex h-9 w-14 shrink-0 items-center justify-center overflow-hidden rounded border bg-muted/40'
  const fallbackIconSize = size === 'card' ? 'size-8' : 'size-4'

  const showFallback = hasDaemonApi ? failed || !objectUrl : failed

  return (
    <div className={cn(wrapperClasses, className)}>
      {showFallback ? (
        // No thumbnail yet — generic icon instead of an empty gray box.
        <FileText className={cn(fallbackIconSize, 'text-muted-foreground/50')} />
      ) : hasDaemonApi ? (
        <img
          src={objectUrl ?? undefined}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-full w-full object-contain"
        />
      ) : (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="h-full w-full object-contain"
        />
      )}
    </div>
  )
}
