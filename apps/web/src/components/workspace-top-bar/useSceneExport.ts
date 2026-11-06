import { useCallback, useState } from 'react'
import type { SceneExportFormat } from '../../hooks/useDocumentSync.js'
import type { AppLogger } from '../../lib/app-logger.js'
import type { ExportScope } from '../../lib/spatial/selection-picture.js'

// Keyed by SceneExportFormat so a new format must add its own entry rather
// than silently inheriting a default.
const EXPORT_CONFIG: Record<
  SceneExportFormat,
  { extension: string; label: string; saved?: string }
> = {
  png: { extension: 'png', label: 'PNG' },
  svg: { extension: 'svg', label: 'SVG' },
  'png-comments': { extension: 'png', label: 'PNG (with comments)' },
  'svg-comments': { extension: 'svg', label: 'SVG (with comments)' },
  md: { extension: 'md', label: 'Markdown', saved: 'Markdown' },
  canvas: { extension: 'canvas', label: 'JSON Canvas', saved: 'JSON Canvas' },
}

interface UseSceneExportOptions {
  onExport: ((format: SceneExportFormat, scope?: ExportScope) => Promise<Blob | null>) | undefined
  filenameBase: string
  /** Told, once the file has gone out, what to say about it (e.g. "Exported as PNG"). */
  onExported?: (message: string) => void
  log?: AppLogger
}

async function textHasAsset(blob: Blob): Promise<boolean> {
  return new TextDecoder().decode(await blob.arrayBuffer()).includes('asset:')
}

/** A picture (`![…](…)`) or an embed (`![[…]]`): what a .md file names and cannot carry. */
const PICTURE_OR_EMBED = /!\[\[|!\[[^\]\n]*\]\(/

async function textHasPicture(blob: Blob): Promise<boolean> {
  return PICTURE_OR_EMBED.test(new TextDecoder().decode(await blob.arrayBuffer()))
}

/** How a Markdown save's confirmation begins: the menu shows that one on screen as well. */
export const MARKDOWN_SAVED_NOTICE = `Saved as ${EXPORT_CONFIG.md.saved}`

/** Where a confirmation's caveat starts, after what was saved. */
export const NOTICE_CAVEAT_SEPARATOR = ' — '

/** What the confirmation says the saved text left out, if anything. */
async function savedCaveat(format: SceneExportFormat, blob: Blob): Promise<string> {
  // An image in a canvas is an `asset:` reference to the workspace's file,
  // so the saved text does not carry its pixels.
  if (format === 'canvas' && (await textHasAsset(blob))) {
    return `${NOTICE_CAVEAT_SEPARATOR}images are referenced, not embedded`
  }
  // A note's pictures and embedded diagrams are named, not drawn, in its .md.
  if (format === 'md' && (await textHasPicture(blob))) {
    return `${NOTICE_CAVEAT_SEPARATOR}pictures and embedded diagrams are not included; for a handout, use Print / Save as PDF`
  }
  return ''
}

function exportedNotice(label: string, scope: ExportScope | undefined): string {
  // Kept out of the handler: it already sits at the complexity ceiling.
  return scope === undefined ? `Exported as ${label}` : `Exported the selection as ${label}`
}

// Export has no dialog of its own (it's a plain dropdown action), so a
// failed or unavailable export is surfaced next to the trigger instead.
export function useSceneExport({ onExport, filenameBase, onExported, log }: UseSceneExportOptions) {
  const [exportError, setExportError] = useState<string | null>(null)

  const handleExport = useCallback(
    async (format: SceneExportFormat, scope?: ExportScope) => {
      if (!onExport) return
      setExportError(null)
      const { extension, label, saved } = EXPORT_CONFIG[format]
      try {
        const blob = await (scope === undefined ? onExport(format) : onExport(format, scope))
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
          onExported?.(exportedNotice(label, scope))
        } else {
          onExported?.(`Saved as ${saved}${await savedCaveat(format, blob)}`)
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
