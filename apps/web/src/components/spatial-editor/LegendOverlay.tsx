/**
 * The board's legend, in a corner of the editor
 * ([ADR-0040](../../../../../docs/contributing/adr/0040-scoped-tags.md)
 * decision 6): what the LAYOUT attached to the scene, drawn as the editor's
 * own overlay — the same `SceneLegend` the SVG backend draws into an export,
 * so the reader of the screen and the reader of the PNG are told the same
 * thing. Shown only when the board has something to say; collapsible to its
 * title, since a legend is for reading and not for editing.
 *
 * Positioned divs rather than an `<svg>`, for the reason the minimap gives:
 * the editor's scene is the one SVG in this container and tests reach for
 * it by tag.
 */
import type { SceneLegend } from '@kamiazya/whiteboard-canvas-render'
import { ChevronDown } from 'lucide-react'
import { useState } from 'react'

const UNTAGGED = 'untagged'

export function LegendOverlay({ legend }: { readonly legend: SceneLegend }) {
  const [open, setOpen] = useState(true)
  return (
    <aside
      data-editor-overlay
      data-testid="legend-overlay"
      aria-label="Legend"
      className="bg-background/95 text-foreground rounded border border-border shadow-sm text-xs"
      // z-10 like the minimap: over the scene, under a dialog.
      style={{ position: 'absolute', left: 12, top: 12, zIndex: 10, pointerEvents: 'auto' }}
    >
      {/* The state is DERIVED from `aria-expanded` (the chevron turns on the
          variant), never doubled in a parallel boolean — toggle-state-surface.test.ts. */}
      <button
        type="button"
        aria-expanded={open}
        aria-label="Toggle legend"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-2 py-1 font-medium [&_svg]:transition-transform aria-expanded:[&_svg]:rotate-180"
      >
        <span>Legend</span>
        <ChevronDown aria-hidden className="size-3" />
      </button>
      {open && (
        <div className="flex flex-col gap-1 px-2 pb-2">
          {legend.keys.map((key) => (
            <div key={`${key.of}:${key.key}`} className="flex flex-col gap-0.5">
              <span className="text-muted-foreground font-medium">{key.key}</span>
              {key.entries.map((entry) => (
                <span
                  key={entry.value}
                  className="flex items-center gap-1.5"
                  data-testid={`legend-${key.of}-${entry.value === '' ? UNTAGGED : entry.value}`}
                >
                  {key.of === 'edges' ? (
                    <span
                      aria-hidden
                      style={{
                        display: 'inline-block',
                        width: 16,
                        height: 0,
                        borderTop: `2px solid ${entry.swatch.stroke ?? 'currentColor'}`,
                      }}
                    />
                  ) : (
                    <span
                      aria-hidden
                      style={{
                        display: 'inline-block',
                        width: 16,
                        height: 11,
                        borderRadius: 2,
                        background: entry.swatch.fill ?? 'transparent',
                        border: `1px solid ${entry.swatch.stroke ?? 'currentColor'}`,
                      }}
                    />
                  )}
                  <span>{entry.value === '' ? UNTAGGED : entry.value}</span>
                </span>
              ))}
            </div>
          ))}
          {legend.uncarried.boxes && (
            <span className="text-muted-foreground">box colour: no key carries it</span>
          )}
          {legend.uncarried.edges && (
            <span className="text-muted-foreground">edge colour: no key carries it</span>
          )}
        </div>
      )}
    </aside>
  )
}
