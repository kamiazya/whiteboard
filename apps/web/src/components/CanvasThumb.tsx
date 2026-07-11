import { FileText } from 'lucide-react'
import { useState } from 'react'
import { useHasDaemonApi } from '@/contexts/DaemonApiContext'
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
  // mounted) always falls back to the placeholder icon instead of a broken
  // image request. See VersionThumbnail for the equivalent fetch-and-blob
  // treatment where an authorized image is worth the extra bookkeeping.
  const hasDaemonApi = useHasDaemonApi()
  const [failed, setFailed] = useState(false)
  const src = `/api/workspaces/${encodeURIComponent(workspaceId)}/canvases/${encodeURIComponent(slug)}/latest-thumbnail`
  // Instances are reused across re-renders with a new slug/workspaceId (e.g.
  // the canvas switcher dropdown), so a stale `failed` flag from a previous
  // src must not leak into the next canvas's thumbnail. Reset during render
  // (not in an effect) so the fallback icon never flashes for one frame.
  const [prevSrc, setPrevSrc] = useState(src)
  if (prevSrc !== src) {
    setPrevSrc(src)
    setFailed(false)
  }
  const wrapperClasses =
    size === 'card'
      ? 'flex aspect-[16/9] w-full items-center justify-center overflow-hidden rounded-md border bg-muted/40'
      : 'flex h-9 w-14 shrink-0 items-center justify-center overflow-hidden rounded border bg-muted/40'
  const fallbackIconSize = size === 'card' ? 'size-8' : 'size-4'
  return (
    <div className={cn(wrapperClasses, className)}>
      {failed || hasDaemonApi ? (
        // No thumbnail yet — generic icon instead of an empty gray box.
        <FileText className={cn(fallbackIconSize, 'text-muted-foreground/50')} />
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
