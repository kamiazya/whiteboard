import { useCallback, useState } from 'react'
import type { SceneExportFormat } from '../../hooks/useDocumentSync.js'
import type { AppLogger } from '../../lib/app-logger.js'

// Keyed by SceneExportFormat so a new format must add its own entry rather
// than silently inheriting a default.
const EXPORT_CONFIG: Record<
  SceneExportFormat,
  { extension: string; label: string; saved?: string }
> = {
  png: { extension: 'png', label: 'PNG' },
  svg: { extension: 'svg', label: 'SVG' },
  md: { extension: 'md', label: 'Markdown', saved: 'Markdown' },
  canvas: { extension: 'canvas', label: 'JSON Canvas', saved: 'JSON Canvas' },
}

interface UseSceneExportOptions {
  onExport: ((format: SceneExportFormat) => Promise<Blob | null>) | undefined
  filenameBase: string
  /** Told, once the file has gone out, what to say about it (e.g. "Exported as PNG"). */
  onExported?: (message: string) => void
  log?: AppLogger
}

async function textHasAsset(blob: Blob): Promise<boolean> {
  return new TextDecoder().decode(await blob.arrayBuffer()).includes('asset:')
}

// Export has no dialog of its own (it's a plain dropdown action), so a
// failed or unavailable export is surfaced next to the trigger instead.
export function useSceneExport({ onExport, filenameBase, onExported, log }: UseSceneExportOptions) {
  const [exportError, setExportError] = useState<string | null>(null)

  const handleExport = useCallback(
    async (format: SceneExportFormat) => {
      if (!onExport) return
      setExportError(null)
      const { extension, label, saved } = EXPORT_CONFIG[format]
      try {
        const blob = await onExport(format)
        if (!blob) {
          setExportError(`Export as ${label} failed: no data to export.`)
          return
        }
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = `${filenameBase}.${extension}`
        // Firefox (and the HTML spec generally) will not start a download from
        // a synthetic click() on an <a> that isn't attached to the document —
        // it must be appended before clicking and can be removed right after.
        document.body.appendChild(anchor)
        anchor.click()
        document.body.removeChild(anchor)
        // Revoking synchronously can race the browser's download manager in
        // Chrome/Safari before it has read the blob URL; deferring past the
        // current task lets the download start first.
        setTimeout(() => URL.revokeObjectURL(url), 0)
        if (saved === undefined) {
          onExported?.(`Exported as ${label}`)
        } else {
          // An image in a canvas is an `asset:` reference to the workspace's
          // file, so the saved text does not carry its pixels.
          const referencesImages = format === 'canvas' && (await textHasAsset(blob))
          onExported?.(
            referencesImages
              ? `Saved as ${saved} — images are referenced, not embedded`
              : `Saved as ${saved}`,
          )
        }
      } catch (err) {
        log?.error('canvas export failed:', err)
        setExportError(`Export as ${label} failed.`)
      }
    },
    [onExport, filenameBase, onExported, log],
  )

  return { exportError, handleExport }
}
