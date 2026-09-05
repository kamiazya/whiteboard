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
import { nextLayoutRequestId, sharedLayoutWorkerPool } from '../lib/layout-worker-pool.js'
import type { MarkdownRailResponse } from '../lib/layout-worker-protocol.js'
import type { RailBlock } from '../lib/rail-geometry.js'

export interface MarkdownOutline {
  readonly blocks: readonly RailBlock[]
  readonly anchors: readonly { line: number; y: number }[]
  /**
   * The body this shape was computed FOR.
   *
   * The hook holds its last result while disabled and after a refusal, which
   * is what stops a rail from blinking empty on every keystroke — and is
   * exactly why a consumer must not assume the shape describes what it is
   * looking at now. A document edited while the hook was disabled comes back
   * to a shape of the OLD text, and anchors from it reveal the wrong line.
   */
  readonly forBody: string | null
}

const EMPTY: MarkdownOutline = { blocks: [], anchors: [], forBody: null }

export function useMarkdownOutline(
  body: string,
  { enabled, maxWidth }: { enabled: boolean; maxWidth: number },
): MarkdownOutline {
  const [outline, setOutline] = useState<MarkdownOutline>(EMPTY)

  useEffect(() => {
    if (!enabled || body.trim() === '' || !(maxWidth > 0)) {
      // An empty document HAS a known shape — none — so say so rather than
      // holding the last one. Retaining across a disable is what stops the
      // rail blinking mid-edit; retaining across a CLEAR would draw a
      // document that is no longer there.
      // A functional update, and NOT `outline` in the deps: depending on the
      // state this effect sets makes it re-run its own dispatch, cancelling
      // and re-issuing a request on every reply.
      if (body.trim() === '') setOutline((prev) => (prev === EMPTY ? prev : EMPTY))
      return
    }
    const pool = sharedLayoutWorkerPool()
    const id = nextLayoutRequestId()
    let live = true
    pool
      .run<MarkdownRailResponse>({ type: 'markdown-rail', id, body, maxWidth }, 'background')
      .then((reply) => {
        if (live && reply.type === 'markdown-rail-done') {
          setOutline({ blocks: reply.blocks, anchors: reply.anchors, forBody: body })
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
