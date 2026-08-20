import type { FontCatalogueItem } from '@kamiazya/whiteboard-mcp/api-contracts'
import { Check, Download, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useDaemonApi } from '../contexts/DaemonApiContext.js'
import { installFont, listFonts } from '../lib/daemon-api-client.js'
import { Button } from './ui/button.js'

// Relative, because `createDaemonFetch` prefixes the daemon origin — the same
// convention the other daemon-backed settings cards use.
const RELATIVE = ''

type ListState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; fonts: readonly FontCatalogueItem[] }

function formatSize(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`
}

/**
 * Pick a font, and the daemon keeps it (ADR-0012).
 *
 * The catalogue is the daemon's, not this component's: the browser sends an
 * id it was given and never a URL, so nothing here — and nothing that talks to
 * this app — can choose where the daemon reaches.
 *
 * What it reports is deliberately one-sided. `installed` means the DAEMON has
 * the face, which is what decides whether an EXPORT renders the text or a row
 * of tofu boxes. Whether this browser can also draw it on screen is a separate
 * question with a separate answer, and calling both "installed" would hide the
 * mismatch that matters.
 */
export function FontsCard() {
  const fetchApi = useDaemonApi()
  const [state, setState] = useState<ListState>({ kind: 'loading' })
  const [busyId, setBusyId] = useState<string | null>(null)
  const [failures, setFailures] = useState<Readonly<Record<string, string>>>({})
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const { fonts } = await listFonts(fetchApi, RELATIVE)
      if (mounted.current) setState({ kind: 'loaded', fonts })
    } catch (err) {
      if (mounted.current) {
        setState({ kind: 'error', message: err instanceof Error ? err.message : 'Request failed.' })
      }
    }
  }, [fetchApi])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const install = useCallback(
    async (font: FontCatalogueItem) => {
      setBusyId(font.id)
      setFailures((prev) => {
        const { [font.id]: _dropped, ...rest } = prev
        return rest
      })
      try {
        await installFont(fetchApi, RELATIVE, font.id)
        if (!mounted.current) return
        setState((prev) =>
          prev.kind === 'loaded'
            ? {
                kind: 'loaded',
                fonts: prev.fonts.map((item) =>
                  item.id === font.id ? { ...item, installed: true } : item,
                ),
              }
            : prev,
        )
      } catch (err) {
        if (!mounted.current) return
        setFailures((prev) => ({
          ...prev,
          [font.id]: err instanceof Error ? err.message : 'Install failed.',
        }))
      } finally {
        if (mounted.current) setBusyId(null)
      }
    },
    [fetchApi],
  )

  return (
    <div>
      <h3 className="text-sm font-medium">Fonts</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Exports are drawn with the fonts this daemon has. Without a face covering the script you
        write in, those characters export as empty boxes. Fonts are downloaded from Google Fonts and
        licensed under the SIL Open Font License.
      </p>

      {/* Mounted unconditionally and emptied rather than removed: a polite
          live region inserted already carrying its text is announced
          unreliably. `empty:mt-0` keeps it in the accessibility tree while
          costing no layout — `hidden` would prune it from that tree, which is
          the same bug wearing different clothes. */}
      <p className="mt-3 text-xs text-muted-foreground empty:mt-0" role="status">
        {state.kind === 'loading' ? 'Loading fonts…' : ''}
      </p>
      {state.kind === 'error' && (
        <div className="mt-3 text-xs text-destructive">{state.message}</div>
      )}
      {state.kind === 'loaded' && (
        <ul className="mt-3 divide-y rounded-md border">
          {state.fonts.map((font) => (
            <li key={font.id} className="px-3 py-2" data-font-row={font.id}>
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{font.family}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {font.scripts.join(', ')} · {formatSize(font.approxBytes)} · {font.license}
                  </div>
                </div>
                {font.installed ? (
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Check className="size-3.5" />
                    Installed
                  </span>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1.5"
                    disabled={busyId !== null}
                    onClick={() => void install(font)}
                    aria-label={`Install ${font.family}`}
                  >
                    {busyId === font.id ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Download className="size-3.5" />
                    )}
                    <span className="text-xs">Install</span>
                  </Button>
                )}
              </div>
              {failures[font.id] !== undefined && (
                <div className="mt-1 text-[11px] text-destructive">{failures[font.id]}</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
