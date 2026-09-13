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

import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { nodeUrl } from '@kamiazya/whiteboard-model'
import { ExternalLink, Play, X } from 'lucide-react'
import { useState } from 'react'
import { isFollowableUrl } from './followable-url.js'

const MAX_LIVE_IFRAMES = 3

export interface LinkEmbedLayerProps {
  readonly canvas: SpatialCanvas
  /** The LOD gate: only link nodes this returns true for offer the facade. */
  /**
   * Takes any node, not the link arm. The arm type is what ADR-0038 decision
   * 3 removes, and a prop declaring it is a prop the flip has to visit; the
   * layer has already established this node has a url before it asks.
   */
  readonly shouldOffer: (node: SpatialNode) => boolean
  /**
   * False while the editor's tool is navigation-only (the hand tool), where
   * every press has to pan — including one that lands on this layer.
   *
   * `data-editor-overlay` alone cannot express that: it makes the root ignore
   * the press, which is what a control wants and the opposite of what a
   * navigation gesture wants. It also cannot help at all once the iframe is
   * live, because an iframe consumes the pointer before any handler of ours
   * runs. `pointer-events: none` is the only thing that answers both.
   */
  readonly interactive: boolean
}

export function LinkEmbedLayer({ canvas, shouldOffer, interactive }: LinkEmbedLayerProps) {
  // Activation order doubles as the LRU: first entry is the oldest.
  const [liveIds, setLiveIds] = useState<readonly string[]>([])

  // The url travels BESIDE the node rather than being read off it again in
  // the markup. Narrowing to the link arm is what the ADR-0038 decision 3
  // flip removes, and every `url` below would have had to move with it.
  const linkNodes = canvas.nodes.flatMap((node) => {
    const url = nodeUrl(node)
    return url !== undefined && isFollowableUrl(url) && shouldOffer(node) ? [{ node, url }] : []
  })
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
      {linkNodes.map(({ node, url }) =>
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
              pointerEvents: interactive ? undefined : 'none',
            }}
            className="overflow-hidden rounded-md border bg-background shadow-sm"
          >
            <iframe
              src={url}
              title={url}
              // No allow-same-origin: the embedded page runs in an opaque
              // origin and cannot reach this app's storage or DOM.
              sandbox="allow-scripts allow-popups"
              referrerPolicy="no-referrer"
              loading="lazy"
              className="h-full w-full border-0"
            />
            <span className="absolute top-1 right-1 flex gap-1">
              <a
                href={url}
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
            aria-label={`Load ${url}`}
            onClick={() => activate(node.id)}
            style={{
              position: 'absolute',
              // Centered on the node, small — the SVG card stays the
              // visual; this is only the activation affordance.
              left: node.x + node.width / 2 - 14,
              top: node.y + node.height / 2 - 14 + 8,
              width: 28,
              height: 28,
              pointerEvents: interactive ? undefined : 'none',
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
