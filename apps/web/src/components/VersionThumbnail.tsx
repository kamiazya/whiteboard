import { useEffect, useState } from 'react'
import { useDaemonApi, useHasDaemonApi } from '@/contexts/DaemonApiContext'

interface VersionThumbnailProps {
  workspaceId: string
  slug: string
  versionId: string
  hasThumbnail: boolean
  className?: string
}

function Placeholder({ className }: { className?: string }) {
  return (
    <div
      data-testid="version-thumbnail-placeholder"
      aria-hidden
      className={className ?? 'w-full h-20 bg-muted/30'}
    />
  )
}

/**
 * Renders a version's thumbnail image.
 *
 * A plain <img src> cannot carry the daemon's own origin or bearer token, so
 * in daemon mode (a DaemonApiContext provider mounted) this fetches the
 * image through the authorized daemon fetch and exposes it via an object
 * URL instead. The same-origin mcp-server app has no such constraint and
 * keeps the cheaper plain <img src> path with no objectURL bookkeeping.
 */
export function VersionThumbnail({
  workspaceId,
  slug,
  versionId,
  hasThumbnail,
  className,
}: VersionThumbnailProps) {
  const fetchFn = useDaemonApi()
  const hasDaemonApi = useHasDaemonApi()
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  const path = `/api/workspaces/${encodeURIComponent(workspaceId)}/canvases/${encodeURIComponent(slug)}/versions/${encodeURIComponent(versionId)}/thumbnail`

  useEffect(() => {
    if (!hasThumbnail || !hasDaemonApi) return

    let cancelled = false
    let createdUrl: string | null = null
    setFailed(false)
    setObjectUrl(null)

    async function load(): Promise<void> {
      try {
        const res = await fetchFn(path)
        if (!res.ok) {
          if (!cancelled) setFailed(true)
          return
        }
        const blob = await res.blob()
        if (cancelled) return
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
    // path is derived purely from these identity fields; fetchFn is the
    // context-provided function and is not expected to change identity
    // across a poll-driven re-render of the same canvas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, slug, versionId, hasThumbnail, hasDaemonApi])

  if (!hasThumbnail) return <Placeholder className={className} />
  if (!hasDaemonApi) {
    return (
      <img
        src={path}
        alt="Version thumbnail"
        className={className ?? 'w-full h-20 object-contain'}
        loading="lazy"
      />
    )
  }
  if (failed || !objectUrl) return <Placeholder className={className} />
  return (
    <img
      src={objectUrl}
      alt="Version thumbnail"
      className={className ?? 'w-full h-20 object-contain'}
      loading="lazy"
    />
  )
}
