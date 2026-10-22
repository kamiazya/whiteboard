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
import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { FragmentAsk, FragmentEntry } from '../../lib/fragment-requests.js'
import {
  type FileRefLabel,
  FONT_DEGRADED,
  type LayoutRequest,
} from '../../lib/layout-worker-protocol.js'
import { type RenderCanvasOptions, renderCanvasToSvg } from '../../lib/spatial/scene-render.js'
import type { RenderedCanvas } from '../../lib/spatial/scene-render-core.js'
import type { ResolvedTheme } from '../../lib/theme.js'
import { attachThemeFaces } from '../../lib/theme-fonts.js'
import { createLayoutChannel } from './layout-channel.js'

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
    const worker = new Worker(new URL('../../lib/layout-worker.ts', import.meta.url), {
      type: 'module',
    })
    // The worker holds the theme faces this realm holds, now and as they
    // land, or it would declare the bundled family where the main thread
    // declares the theme's. Detached with the worker: every retirement
    // below goes through `terminate`, so the subscription cannot outlive it.
    const detachFaces = attachThemeFaces(worker)
    const terminate = worker.terminate.bind(worker)
    worker.terminate = () => {
      detachFaces()
      terminate()
    }
    return worker
  } catch {
    // No module-worker support, or a bundler that could not produce the
    // chunk: the synchronous path below is the whole of the fallback.
    return null
  }
}

/**
 * The plain-data twins of the seams in `fileSeamOptions`: the label table,
 * the refs the host resolved as dangling in THIS canvas, the reference graph
 * with its tables, the ids the LOD gate expanded, and the fragments rendered
 * so far. The composed seams serve the synchronous path; only this can cross
 * to the worker, which rebuilds the same seams from it.
 */
interface WorkerSceneWire {
  readonly fileRefLabels?: readonly FileRefLabel[]
  readonly missingFileRefs?: readonly string[]
  readonly references?: ReferenceWire
  /** Changes exactly when `references` does (`useCanvasReferences`). */
  readonly referencesRevision?: number
  readonly expandedFileIds?: readonly string[]
  readonly fragments?: readonly FragmentEntry[]
  /** Where a worker layout's fragment misses go, to be rendered on this thread. */
  readonly onFragmentsAsked?: (asks: readonly FragmentAsk[]) => void
}

/** What one offloaded layout is built from — the request's own fields, so the two cannot drift. */
type SceneInputs = Pick<
  LayoutRequest,
  | 'theme'
  | 'fileRefLabels'
  | 'missingFileRefs'
  | 'references'
  | 'referencesRevision'
  | 'expandedFileIds'
  | 'fragments'
  | 'suppressedBodyNodeIds'
  | 'lockedNodeIds'
  | 'showResolved'
  | 'threads'
  | 'proposals'
  | 'tagLibrary'
  | 'style'
> & {
  readonly canvas: SpatialCanvas
  /**
   * Not sent to the worker — it asks `hasLoadedFace` itself — but a change
   * here is what makes an OFFLOADED scene lay out again once a theme's face
   * lands; the synchronous path re-runs off `options`.
   */
  readonly fontsGeneration: number | undefined
}

function layoutRequestFor(id: number, sent: SceneInputs): LayoutRequest {
  const { fontsGeneration: _notSent, ...request } = sent
  return { type: 'layout', id, ...request }
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
    /** Nodes that wear a padlock; sorted and referentially stable, like the above. */
    readonly lockedNodeIds?: readonly string[]
    /** Draw resolved comments too; view state, threaded to the worker as data. */
    readonly showResolved?: boolean
    /** The document's conversations, for passage highlights (plain data, crosses to the worker). */
    readonly threads?: readonly CommentThread[]
    /** This document's open proposals, drawn in place (ADR-0029 decision 1). */
    readonly proposals?: readonly Proposal[]
    /** The workspace's tag library (ADR-0040 decision 5); plain data, crosses to the worker. */
    readonly tagLibrary?: TagLibrary
    /**
     * How many theme faces have landed in this tab (`useThemeFontsGeneration`).
     * Not read by the layout — it asks `hasLoadedFace` itself — but a change
     * here is what makes the scene lay out again once a family a theme
     * names becomes measurable.
     */
    readonly fontsGeneration?: number
  },
  // `commentObstacles` is left out because the worker request cannot carry
  // it: past the offload threshold it would be dropped, and a large canvas
  // would draw differently from a small one.
  fileSeamOptions: Omit<RenderCanvasOptions, 'measure' | 'theme' | 'commentObstacles'>,
  wire?: WorkerSceneWire,
): RenderedCanvas & { readonly sceneCurrent: boolean } {
  const fileRefLabels = wire?.fileRefLabels
  const missingFileRefs = wire?.missingFileRefs
  const references = wire?.references
  const referencesRevision = wire?.referencesRevision
  const expandedFileIds = wire?.expandedFileIds
  const fragments = wire?.fragments
  const options = useMemo(
    () => ({ ...base, ...fileSeamOptions }),
    [
      base.measure,
      base.theme,
      base.suppressedBodyNodeIds,
      base.lockedNodeIds,
      base.showResolved,
      base.threads,
      base.proposals,
      base.tagLibrary,
      base.fontsGeneration,
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
  const [rendered, setRendered] = useState<RenderedCanvas>(renderNow)
  // The inputs the currently-displayed scene was built from, so a scene that
  // is merely stale is distinguishable from one that is current.
  const shownFor = useRef<unknown>(null)

  const inputs = useMemo(
    (): SceneInputs => ({
      canvas,
      theme: options.theme,
      fileRefLabels,
      missingFileRefs,
      references,
      referencesRevision,
      expandedFileIds,
      fragments,
      suppressedBodyNodeIds: options.suppressedBodyNodeIds,
      lockedNodeIds: options.lockedNodeIds,
      showResolved: options.showResolved,
      threads: options.threads,
      proposals: options.proposals,
      tagLibrary: options.tagLibrary,
      style: options.style,
      fontsGeneration: options.fontsGeneration,
    }),
    [
      canvas,
      options.theme,
      fileRefLabels,
      missingFileRefs,
      references,
      referencesRevision,
      expandedFileIds,
      fragments,
      options.suppressedBodyNodeIds,
      options.lockedNodeIds,
      options.showResolved,
      options.threads,
      options.proposals,
      options.tagLibrary,
      options.style,
      options.fontsGeneration,
    ],
  )

  // What a reply that lands later reads: the inputs and the fallback as they
  // stand when it lands, not as they stood when the request went out.
  const latest = useRef({ inputs, renderNow, onFragmentsAsked: wire?.onFragmentsAsked })
  latest.current = { inputs, renderNow, onFragmentsAsked: wire?.onFragmentsAsked }
  const channel = useMemo(
    () =>
      createLayoutChannel<SceneInputs>({
        requestFor: layoutRequestFor,
        onReply: (response, sent, worker) => {
          if (response.type === 'failed') {
            if (response.reason === FONT_DEGRADED) {
              fontDegraded.current = true
              // Not a transient failure: this realm cannot measure text the
              // way the main thread does, so every later request would be
              // wrong the same way. Retire the worker and stay synchronous.
              worker.terminate()
              workerRef.current = null
            }
            shownFor.current = latest.current.inputs
            setRendered(latest.current.renderNow())
            return
          }
          // Drawn even when superseded: it is newer than what is on screen,
          // and under a steady stream of edits no reply would ever be the
          // newest. `sceneCurrent` says which it is.
          shownFor.current = sent
          if (response.type === 'laid-out') {
            latest.current.onFragmentsAsked?.(response.fragmentsAsked ?? [])
            setRendered(response)
          }
        },
        // A worker whose MODULE fails to evaluate never throws at
        // construction; it fires `error` and no reply ever comes. That is as
        // permanent as a missing face, so the session stays synchronous —
        // a degraded worker costs responsiveness, never content.
        onWorkerError: (worker) => {
          worker.terminate()
          workerRef.current = null
          workerDead.current = true
          shownFor.current = latest.current.inputs
          setRendered(latest.current.renderNow())
        },
      }),
    [],
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
    channel.submit(worker, inputs)
    // `renderNow` closes over the current inputs by design: a fallback must
    // lay out what was asked for, not what the effect last saw.
  }, [inputs, offloadable, channel])

  // Started at MOUNT, not on the first edit. The worker's module load and its
  // font registration are one-time costs, and paying them inside the first
  // edit made that edit 353ms against 94ms synchronous — the worst possible
  // moment, since it is also a user's first impression of the canvas. Warming
  // it while they are still reading brings that edit back to the steady state.
  useEffect(() => {
    if (!offloadable || fontDegraded.current || workerDead.current) return
    workerRef.current ??= createLayoutWorker()
  }, [offloadable])

  useEffect(
    // Everything reset, not only stopped: StrictMode runs this once before the
    // real session, and a request left marked in flight would hold every later
    // input pending for good.
    () => () => {
      channel.reset()
      workerRef.current?.terminate()
      workerRef.current = null
    },
    [channel],
  )

  // Whether the scene handed back was built from the CURRENT inputs. The
  // synchronous path always is; the offloaded path lags by one worker round
  // trip after any input change. The editor overlay reads this to keep the
  // old opaque cover up for exactly that gap, so a big canvas never shows
  // its committed text doubled under the transparent editor.
  const sceneCurrent = synchronous !== undefined || shownFor.current === inputs
  return { ...(synchronous ?? rendered), sceneCurrent }
}
