/**
 * A markdown document's laid-out shape, computed off the main thread.
 *
 * The shape is what several surfaces draw — the editor's rail, the favicon,
 * a list row's icon — and none of them can get it from the preview, which
 * only exists while a preview pane is on screen. Laying it out here, once,
 * through the shared pool is what keeps those surfaces from each growing
 * their own layout.
 *
 * Background priority throughout: every consumer is decoration beside
 * something a person is actually waiting on.
 */

import { useEffect, useState } from 'react'
import type { RailBlock } from '../components/markdown-editor/rail-geometry.js'
import { nextLayoutRequestId, sharedLayoutWorkerPool } from '../lib/layout-worker-pool.js'
import type { MarkdownRailResponse } from '../lib/layout-worker-protocol.js'

export interface MarkdownOutline {
  readonly blocks: readonly RailBlock[]
  readonly anchors: readonly { line: number; y: number }[]
}

const EMPTY: MarkdownOutline = { blocks: [], anchors: [] }

export function useMarkdownOutline(
  body: string,
  { enabled, maxWidth }: { enabled: boolean; maxWidth: number },
): MarkdownOutline {
  const [outline, setOutline] = useState<MarkdownOutline>(EMPTY)

  useEffect(() => {
    if (!enabled || body.trim() === '' || !(maxWidth > 0)) return
    const pool = sharedLayoutWorkerPool()
    const id = nextLayoutRequestId()
    let live = true
    pool
      .run<MarkdownRailResponse>({ type: 'markdown-rail', id, body, maxWidth }, 'background')
      .then((reply) => {
        if (live && reply.type === 'markdown-rail-done') {
          setOutline({ blocks: reply.blocks, anchors: reply.anchors })
        }
      })
      // A refusal — no worker font, a superseded request — leaves the last
      // shape in place. Every consumer is a map, not the document.
      .catch(() => undefined)
    return () => {
      live = false
      pool.cancel(id)
    }
  }, [body, enabled, maxWidth])

  return outline
}
