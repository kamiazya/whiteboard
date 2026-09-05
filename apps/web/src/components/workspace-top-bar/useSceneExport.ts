import { useCallback, useState } from 'react'
import type { SceneExportFormat } from '../../hooks/useDocumentSync.js'
import type { AppLogger } from '../../lib/app-logger.js'

// Keyed by SceneExportFormat so a new format must add its own entry rather
// than silently inheriting a default.
const EXPORT_CONFIG: Record<SceneExportFormat, { extension: string; label: string }> = {
  png: { extension: 'png', label: 'PNG' },
  svg: { extension: 'svg', label: 'SVG' },
}

interface UseSceneExportOptions {
  onExport: ((format: SceneExportFormat) => Promise<Blob | null>) | undefined
  filenameBase: string
  log?: AppLogger
}

// Export has no dialog of its own (it's a plain dropdown action), so a
// failed or unavailable export is surfaced next to the trigger instead.
export function useSceneExport({ onExport, filenameBase, log }: UseSceneExportOptions) {
  const [exportError, setExportError] = useState<string | null>(null)

  const handleExport = useCallback(
    async (format: SceneExportFormat) => {
      if (!onExport) return
      setExportError(null)
      const { extension, label } = EXPORT_CONFIG[format]
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
      } catch (err) {
        log?.error('canvas export failed:', err)
        setExportError(`Export as ${label} failed.`)
      }
    },
    [onExport, filenameBase, log],
  )

  return { exportError, handleExport }
}
