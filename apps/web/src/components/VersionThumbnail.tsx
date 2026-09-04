import { useEffect, useState } from 'react'
import { useVersionsBackend } from '@/contexts/VersionsBackendContext'

interface VersionThumbnailProps {
  workspaceId: string
  path: string
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
 * The picture a saved point carries.
 *
 * Asked of the KEEPER rather than of a URL. This component used to build the
 * daemon's route itself, which is what made a picture a thing only one
 * keeper's history could have — the browser's rows had nowhere to fetch
 * from and simply showed less, and no test failed over it. Where the bytes
 * live is now the seam's business: a daemon route, or an IndexedDB store.
 *
 * Always through an object URL, including where the app is served from the
 * same origin as the daemon and a plain `<img src>` would have done. That
 * shortcut cost one branch here and made the component's source of bytes a
 * URL, which is the whole defect above; a keeper that holds a Blob has no
 * URL to offer.
 */
export function VersionThumbnail({
  workspaceId,
  path,
  versionId,
  hasThumbnail,
  className,
}: VersionThumbnailProps) {
  const backend = useVersionsBackend()
  const [objectUrl, setObjectUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!hasThumbnail) return
    let cancelled = false
    let createdUrl: string | null = null
    setObjectUrl(null)

    void (async () => {
      try {
        const blob = await backend.loadThumbnail(workspaceId, path, versionId)
        if (cancelled || blob === null) return
        createdUrl = URL.createObjectURL(blob)
        setObjectUrl(createdUrl)
      } catch {
        // A row whose picture cannot be fetched keeps its place in the
        // history. The picture is a convenience; failing to get one must not
        // cost the row itself.
      }
    })()

    return () => {
      cancelled = true
      if (createdUrl) URL.revokeObjectURL(createdUrl)
    }
  }, [backend, workspaceId, path, versionId, hasThumbnail])

  if (!hasThumbnail || objectUrl === null) return <Placeholder className={className} />
  return (
    <img
      src={objectUrl}
      alt="Version thumbnail"
      className={className ?? 'w-full h-20 object-contain'}
      loading="lazy"
    />
  )
}
