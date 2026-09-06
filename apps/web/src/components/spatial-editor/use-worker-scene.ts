/**
 * The committed scene, laid out off the main thread when that is possible.
 *
 * Layout is the editor's longest synchronous block — measured here at 81ms for
 * an ordinary 20-node/30-edge canvas and 339ms at 60/200, both past the ~50ms
 * a person notices, and paid again on every committed change. Moving it to a
 * worker does not make it faster; it stops it freezing the UI, which is the
 * part a user actually experiences.
 *
 * Three rules keep that from costing correctness:
 *
 * - The FIRST scene is always computed synchronously, so a mount never paints
 *   an empty canvas while a worker boots.
 * - Every later scene keeps the previous one on screen until its replacement
 *   arrives. The visible trade: a change appears one worker round-trip later
 *   instead of blocking the thread until it can appear instantly.
 * - Anything the worker cannot serve — a worker that failed to start or
 *   threw, a realm without the vendored face — falls
 *   back to laying the same canvas out synchronously. A degraded worker costs
 *   responsiveness, never content.
 *
 * Markdown is parsed in the WORKER along with layout (see the protocol's
 * note), so an offloaded commit costs this thread nothing but the postMessage.
 */

import type { MeasureText, ReferenceWire } from '@kamiazya/whiteboard-canvas-render'
import type { CommentThread, Proposal, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  type FileRefLabel,
  FONT_DEGRADED,
  type LayoutRequest,
  type LayoutResponse,
} from '../../lib/layout-worker-protocol.js'
import { type RenderCanvasOptions, renderCanvasToSvg } from '../../lib/spatial/scene-render.js'
import type { RenderedCanvas } from '../../lib/spatial/scene-render-core.js'
import type { ResolvedTheme } from '../../lib/theme.js'

/**
 * Below this, layout is not worth a round trip.
 *
 * Going async is not free: the scene arrives a frame later, so a change the
 * user made is on screen one round trip after they made it. That is an
 * excellent trade against a 300ms freeze and a bad one against a 10ms
 * pause — nobody perceives the pause, and everybody perceives the lag.
 *
 * Drawn at the perceptibility line rather than anywhere convenient: measured
 * on this machine, layout is 10.7ms at 6 nodes, ~41ms at 12, and 66-81ms at
 * 20. Roughly 12 nodes is where the block reaches the ~40-50ms a person
 * starts to notice, so that is where paying a stale frame starts to buy
 * something.
 */
const OFFLOAD_MIN_ELEMENTS = 12

function worthOffloading(canvas: SpatialCanvas): boolean {
  return canvas.nodes.length + canvas.edges.length >= OFFLOAD_MIN_ELEMENTS
}

function createLayoutWorker(): Worker | null {
  try {
    return new Worker(new URL('../../lib/layout-worker.ts', import.meta.url), { type: 'module' })
  } catch {
    // No module-worker support, or a bundler that could not produce the
    // chunk: the synchronous path below is the whole of the fallback.
    return null
  }
}

/**
 * The seams arrive as ONE memoized object rather than spread, because the
 * synchronous path memoizes on their identity. Hand-listing them here is how
 * the LOD gate (`expandFileNode`, which changes with zoom) went missing from
 * the dependency array and an expanded embed stopped collapsing.
 */
export function useWorkerScene(
  canvas: SpatialCanvas,
  base: {
    readonly measure: MeasureText
    readonly theme: ResolvedTheme
    /** Node ids whose body an editor overlay owns (see RenderCanvasOptions).
     *  Must be referentially stable across renders, like the seams object —
     *  it participates in the memo below. */
    readonly suppressedBodyNodeIds?: readonly string[]
    /** Draw resolved comments too; view state, threaded to the worker as data. */
    readonly showResolved?: boolean
    /** The document's conversations, for passage highlights (plain data, crosses to the worker). */
    readonly threads?: readonly CommentThread[]
    /** This document's open proposals, drawn in place (ADR-0029 decision 1). */
    readonly proposals?: readonly Proposal[]
  },
  fileSeamOptions: Omit<RenderCanvasOptions, 'measure' | 'theme'>,
  /**
   * The plain-data twins of the seams in `fileSeamOptions`: the label
   * table, the refs the host resolved as dangling in THIS canvas, the
   * reference graph with its tables, and the ids the LOD gate expanded.
   * The composed seams serve the synchronous path; only this can cross to
   * the worker, which rebuilds the same seams from it.
   */
  wire?: {
    readonly fileRefLabels?: readonly FileRefLabel[]
    readonly missingFileRefs?: readonly string[]
    readonly references?: ReferenceWire
    readonly expandedFileIds?: readonly string[]
  },
): RenderedCanvas & { readonly sceneCurrent: boolean } {
  const fileRefLabels = wire?.fileRefLabels
  const missingFileRefs = wire?.missingFileRefs
  const references = wire?.references
  const expandedFileIds = wire?.expandedFileIds
  const options = useMemo(
    () => ({ ...base, ...fileSeamOptions }),
    [
      base.measure,
      base.theme,
      base.suppressedBodyNodeIds,
      base.showResolved,
      base.threads,
      base.proposals,
      fileSeamOptions,
    ],
  )
  const offloadable = worthOffloading(canvas)
  // Synchronous layout of the CURRENT inputs, computed only when it is needed:
  // the first render, and any render the worker cannot serve.
  const renderNow = () => renderCanvasToSvg(canvas, options)

  // A canvas the worker cannot serve keeps TODAY'S behaviour exactly — laid
  // out during render, not in an effect. Routing it through the async path
  // would hand every caller a frame of staleness in exchange for nothing,
  // since nothing was moved off the thread.
  const synchronous = useMemo(
    () => (offloadable ? undefined : renderCanvasToSvg(canvas, options)),
    [offloadable, canvas, options],
  )

  const workerRef = useRef<Worker | null>(null)
  /** Latched: a realm that cannot load the face never will within a session. */
  const fontDegraded = useRef(false)
  /** Latched on a worker `error` event: module evaluation that failed once
   * fails identically on every reconstruction, so the session stays sync. */
  const workerDead = useRef(false)
  const requestRef = useRef(0)
  const [rendered, setRendered] = useState<RenderedCanvas>(renderNow)
  // The inputs the currently-displayed scene was built from, so a scene that
  // is merely stale is distinguishable from one that is current.
  const shownFor = useRef<unknown>(null)

  const inputs = useMemo(
    () => ({
      canvas,
      theme: options.theme,
      fileRefLabels,
      missingFileRefs,
      references,
      expandedFileIds,
      suppressedBodyNodeIds: options.suppressedBodyNodeIds,
      showResolved: options.showResolved,
      threads: options.threads,
      proposals: options.proposals,
    }),
    [
      canvas,
      options.theme,
      fileRefLabels,
      missingFileRefs,
      references,
      expandedFileIds,
      options.suppressedBodyNodeIds,
      options.showResolved,
      options.threads,
      options.proposals,
    ],
  )

  useEffect(() => {
    if (!offloadable) return
    if (shownFor.current === null) {
      // First scene came from `useState`'s initializer; nothing to request.
      shownFor.current = inputs
      return
    }
    if (fontDegraded.current || workerDead.current) {
      shownFor.current = inputs
      setRendered(renderNow())
      return
    }
    workerRef.current ??= createLayoutWorker()
    const worker = workerRef.current
    if (worker === null) {
      shownFor.current = inputs
      setRendered(renderNow())
      return
    }
    const id = ++requestRef.current
    const onMessage = (event: MessageEvent<LayoutResponse>) => {
      const response = event.data
      // A reply for a canvas that has already been superseded is not wrong,
      // just late — dropping it is what keeps the newest edit on screen.
      if (response.id !== requestRef.current) return
      worker.removeEventListener('message', onMessage)
      shownFor.current = inputs
      if (response.type === 'failed' && response.reason === FONT_DEGRADED) {
        fontDegraded.current = true
        // Not a transient failure: this realm cannot measure text the way the
        // main thread does, so every later request would be wrong the same
        // way. Retire the worker and stay synchronous for the session.
        worker.terminate()
        workerRef.current = null
      }
      setRendered(response.type === 'laid-out' ? response : renderNow())
    }
    worker.addEventListener('message', onMessage)
    // A worker whose MODULE fails to evaluate never throws at construction —
    // it fires this event instead, and no `message` will ever come. Without a
    // listener the request would hang and the previous scene would stay on
    // screen for every later edit, which breaks this file's own "a degraded
    // worker costs responsiveness, never content" invariant. Eval failure is
    // as permanent as a missing font face, so the worker is retired the same
    // way and the session stays synchronous.
    const onError = () => {
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
      worker.terminate()
      workerRef.current = null
      workerDead.current = true
      shownFor.current = inputs
      setRendered(renderNow())
    }
    worker.addEventListener('error', onError)
    const request: LayoutRequest = {
      type: 'layout',
      id,
      canvas: inputs.canvas,
      theme: inputs.theme,
      fileRefLabels: inputs.fileRefLabels,
      missingFileRefs: inputs.missingFileRefs,
      references: inputs.references,
      expandedFileIds: inputs.expandedFileIds,
      suppressedBodyNodeIds: inputs.suppressedBodyNodeIds,
      showResolved: inputs.showResolved,
      threads: inputs.threads,
      proposals: inputs.proposals,
    }
    worker.postMessage(request)
    return () => {
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
    }
    // `renderNow` closes over the current inputs by design: a fallback must
    // lay out what was asked for, not what the effect last saw.
  }, [inputs, offloadable])

  // Started at MOUNT, not on the first edit. The worker's module load and its
  // font registration are one-time costs, and paying them inside the first
  // edit made that edit 353ms against 94ms synchronous — the worst possible
  // moment, since it is also a user's first impression of the canvas. Warming
  // it while they are still reading brings that edit back to the steady state.
  useEffect(() => {
    if (!offloadable || fontDegraded.current || workerDead.current) return
    workerRef.current ??= createLayoutWorker()
  }, [offloadable])

  useEffect(() => () => workerRef.current?.terminate(), [])

  // Whether the scene handed back was built from the CURRENT inputs. The
  // synchronous path always is; the offloaded path lags by one worker round
  // trip after any input change. The editor overlay reads this to keep the
  // old opaque cover up for exactly that gap, so a big canvas never shows
  // its committed text doubled under the transparent editor.
  const sceneCurrent = synchronous !== undefined || shownFor.current === inputs
  return { ...(synchronous ?? rendered), sceneCurrent }
}
