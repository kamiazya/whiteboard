/**
 * Editor-only iframe embeds for link nodes (embed spec J6). Rendered
 * INSIDE the viewport-transform container so overlays ride pan/zoom like
 * every canvas-space element; exports never contain any of this — the SVG
 * card is the export form, and this layer only augments the live editor.
 *
 * Industry-standard shape (researched 2026-08-08): never auto-load
 * iframes — a click-to-load facade per node, and at most
 * MAX_LIVE_IFRAMES live at once (activating one more collapses the
 * least-recently-activated back to its facade). The iframe is sandboxed
 * without allow-same-origin, popups escape via the sandbox's own opener
 * severing, and the referrer never leaves the app.
 *
 * Frame refusal (X-Frame-Options / frame-ancestors) is NOT reliably
 * detectable from the parent — no error event fires — so there is no
 * auto-degrade; the "open in new tab" affordance next to the collapse
 * control is the escape hatch when a site refuses to render.
 */
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import { ExternalLink, Play, X } from 'lucide-react'
import { useState } from 'react'
import { isFollowableUrl } from './followable-url.js'

const MAX_LIVE_IFRAMES = 3

export interface LinkEmbedLayerProps {
  readonly canvas: SpatialCanvas
  /** The LOD gate: only link nodes this returns true for offer the facade. */
  readonly shouldOffer: (node: Extract<SpatialNode, { type: 'link' }>) => boolean
}

export function LinkEmbedLayer({ canvas, shouldOffer }: LinkEmbedLayerProps) {
  // Activation order doubles as the LRU: first entry is the oldest.
  const [liveIds, setLiveIds] = useState<readonly string[]>([])

  const linkNodes = canvas.nodes.filter(
    (node): node is Extract<SpatialNode, { type: 'link' }> =>
      node.type === 'link' && isFollowableUrl(node.url) && shouldOffer(node),
  )
  const liveSet = new Set(liveIds)

  const activate = (id: string) => {
    setLiveIds((prev) => {
      const next = [...prev.filter((entry) => entry !== id), id]
      return next.length > MAX_LIVE_IFRAMES ? next.slice(next.length - MAX_LIVE_IFRAMES) : next
    })
  }
  const collapse = (id: string) => {
    setLiveIds((prev) => prev.filter((entry) => entry !== id))
  }

  return (
    <>
      {linkNodes.map((node) =>
        liveSet.has(node.id) ? (
          <div
            key={node.id}
            data-editor-overlay
            data-testid="link-embed-frame"
            style={{
              position: 'absolute',
              left: node.x,
              top: node.y,
              width: node.width,
              height: node.height,
            }}
            className="overflow-hidden rounded-md border bg-background shadow-sm"
          >
            <iframe
              src={node.url}
              title={node.url}
              // No allow-same-origin: the embedded page runs in an opaque
              // origin and cannot reach this app's storage or DOM.
              sandbox="allow-scripts allow-popups"
              referrerPolicy="no-referrer"
              loading="lazy"
              className="h-full w-full border-0"
            />
            <span className="absolute top-1 right-1 flex gap-1">
              <a
                href={node.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Open in new tab"
                className="flex size-6 items-center justify-center rounded bg-background/90 text-muted-foreground shadow hover:text-foreground"
              >
                <ExternalLink aria-hidden="true" className="size-3.5" />
              </a>
              <button
                type="button"
                aria-label="Collapse embed"
                onClick={() => collapse(node.id)}
                className="flex size-6 items-center justify-center rounded bg-background/90 text-muted-foreground shadow hover:text-foreground"
              >
                <X aria-hidden="true" className="size-3.5" />
              </button>
            </span>
          </div>
        ) : (
          <button
            key={node.id}
            type="button"
            data-editor-overlay
            data-testid="link-embed-facade"
            aria-label={`Load ${node.url}`}
            onClick={() => activate(node.id)}
            style={{
              position: 'absolute',
              // Centered on the node, small — the SVG card stays the
              // visual; this is only the activation affordance.
              left: node.x + node.width / 2 - 14,
              top: node.y + node.height / 2 - 14 + 8,
              width: 28,
              height: 28,
            }}
            className="flex items-center justify-center rounded-full border bg-background/95 text-muted-foreground shadow hover:text-foreground"
          >
            <Play aria-hidden="true" className="size-3.5" />
          </button>
        ),
      )}
    </>
  )
}
