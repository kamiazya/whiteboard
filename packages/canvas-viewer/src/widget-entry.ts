// Entry point for the self-contained single-file widget build
// (vite.widget.config.ts -> dist/widget/canvas-viewer.html). Never exported
// from the package's public surface — this file is a build INPUT, loaded
// only by the widget's own <script type="module"> tag.

import { WIDGET_FONTS } from 'virtual:widget-fonts'
import { App } from '@modelcontextprotocol/ext-apps'
import { z } from 'zod'
import { type CanvasViewerHandle, mountCanvasViewer } from './mount.js'
import { parseViewerScene, type ViewerScene } from './scene.js'
import { buildFontFaceDescriptors } from './widget/font-registration.js'
import { createRefreshControl } from './widget/refresh-control.js'
import { createStickyNoteControl } from './widget/sticky-note-control.js'
import { computeStickyPlacement } from './widget/sticky-placement.js'

declare global {
  interface Window {
    // Guarded debug hook, not a public API: exposes exactly the FontFace
    // instances THIS module registered. The widget-smoke script is the only
    // reader.
    __whiteboardWidgetFonts__?: readonly FontFace[]
    // Pre-set by the smoke harness (init script) to opt into the hook above.
    __WHITEBOARD_WIDGET_DEBUG__?: boolean
  }
}

// Registers every embedded font via the FontFace API before the viewer
// mounts, so the SVG's `font-family` attributes resolve against an
// already-loaded face instead of racing whichever element first requests
// the glyph. This is the ONLY font-registration mechanism the widget
// needs: unlike Excalidraw's canvas-based renderer (which this package no
// longer hosts), the SVG viewer's text is real DOM content, and a FontFace
// added to `document.fonts` is exactly what CSS font matching consults —
// no separate injected `<style>` @font-face rule is needed, and adding one
// alongside actively regresses `document.fonts.check()`: the CSS-declared
// entry stays 'unloaded' until first painted, and its mere presence makes
// `check()` report false even though the JS-registered entry is already
// 'loaded'.
function registerFonts(): void {
  const registeredFaces: FontFace[] = []
  for (const font of WIDGET_FONTS) {
    const descriptors = buildFontFaceDescriptors(font)
    const face = new FontFace(font.family, `url(${font.dataUri})`, descriptors)
    document.fonts.add(face)
    registeredFaces.push(face)
    // FontFace.add() alone doesn't trigger a load; force it so
    // document.fonts.check() reports 'loaded' before first paint instead of
    // racing whichever element first requests the glyph.
    void face.load().catch(() => {
      // Malformed embedded font data would otherwise reject silently and
      // leave the viewer to render a fallback glyph with no visible error.
    })
  }

  // Smoke-only instrumentation: only populated when the harness pre-sets
  // the debug flag (via an init script, before this entry runs). The
  // production widget never retains the FontFace list.
  if (window.__WHITEBOARD_WIDGET_DEBUG__ === true) {
    window.__whiteboardWidgetFonts__ = registeredFaces
  }
}

// MCP Apps (SEP-1865) bridge bootstrap. The host sends the canvas_view tool
// result via `ui/notifications/tool-result`; `structuredContent` there is
// the same `{canvasId, scene}` shape returned by canvas_view's Zod
// outputSchema. This widget never receives daemon credentials — only the
// scene snapshot plus, once connected, the host's own MCP session — so its
// only outbound path is re-invoking canvas_view through
// `app.callServerTool`, which is what the Refresh control below does; there
// is no direct daemon access from this document.
//
// When no ext-apps host is embedding this document (e.g. the widget opened
// directly in a browser, or the widget-smoke harness), `app.connect()`
// never resolves because no PostMessageTransport peer answers on the other
// end — `mountFromHost` races that against `hasHostContext` timeout below
// so bootstrap always falls back to mountCanvasViewer's own embedded-scene
// slot instead of hanging forever.
const HOST_CONNECT_TIMEOUT_MS = 2_000

// annotate's execute() (mcp-server tools/annotate.ts) throws for
// type:'box_with_label' when spec.width is undefined — a fixed width keeps
// this append-only affordance from depending on any DOM measurement the
// widget has no reliable way to take inside a sandboxed iframe. `height` is
// deliberately omitted: autoFit defaults to true, so annotate auto-grows the
// box instead of requiring an explicit height.
const STICKY_WIDTH = 260
// Fixed sticky-note fill; `color` (text ink) is deliberately left unset so
// annotate's own readable-ink contrast logic picks a legible ink against
// this fill instead of the widget hardcoding one.
const STICKY_BACKGROUND_COLOR = '#ffec99'

// Both `ui/notifications/tool-result` and the CallToolResult that
// `app.callServerTool` resolves with wrap canvas_view's payload the same
// way: `{structuredContent: {canvasId, scene}}`. Sharing one extraction +
// validation path for the initial mount and every refresh keeps the
// malformed-payload defense (parseViewerScene before remount) and the
// canvasId commit rule (never commit from a result that failed validation)
// in exactly one place. The envelope crosses the host↔widget process
// boundary, so it gets a Zod schema instead of a cast; `scene` stays
// deliberately unknown here — parseViewerScene is its real validator.
const toolResultEnvelopeSchema = z.object({
  structuredContent: z
    .object({
      canvasId: z.string().optional(),
      scene: z.unknown().optional(),
    })
    .catchall(z.unknown())
    .optional(),
})

function extractCanvasIdAndScene(payload: unknown): { canvasId?: string; scene?: unknown } {
  const parsed = toolResultEnvelopeSchema.safeParse(payload)
  if (!parsed.success) return {}
  const structuredContent = parsed.data.structuredContent
  return { canvasId: structuredContent?.canvasId, scene: structuredContent?.scene }
}

// Validates BEFORE remount: remount disposes the live viewer first, so a
// malformed payload would otherwise trade a working view for an empty
// container. `onValidResult` only fires once parseViewerScene has actually
// accepted the scene, which is what lets the canvasId commit rule ("never
// remember an ID from an unvalidated result") hold for both the initial
// tool-result and every subsequent refresh response.
// Also whether a result is an application-level failure rather than a
// transport-level rejection: the ext-apps host resolves (never rejects) a
// server-side tool handler exception as `{isError: true}` — treating that as
// success would remount on annotate's own error payload or skip the
// required post-annotation refresh.
function isErrorResult(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { isError?: unknown }).isError === true
  )
}

function applyToolResult(
  payload: unknown,
  container: HTMLElement,
  remount: (mount: () => CanvasViewerHandle) => void,
  onValidResult: (canvasId: string | undefined, scene: ViewerScene) => void,
): void {
  if (isErrorResult(payload)) {
    console.error('[whiteboard-widget] ignoring tool-result carrying an error result:', payload)
    return
  }
  const { canvasId, scene } = extractCanvasIdAndScene(payload)
  const result = parseViewerScene(scene)
  if (!result.ok) {
    // Surfaced for host-integration debugging: the widget deliberately
    // keeps the current view on malformed payloads, which would otherwise
    // make a host sending the wrong shape look like a silent no-op.
    console.error('[whiteboard-widget] ignoring tool-result with invalid scene:', result.error)
    return
  }
  remount(() => mountCanvasViewer(container, { scene }))
  onValidResult(canvasId, result.value)
}

// `remount` is the single place a mount produced by this bridge happens.
// `app.connect()` racing HOST_CONNECT_TIMEOUT_MS means a tool-result can
// legitimately arrive AFTER the caller already decided `connectedToHost`
// was false and mounted its own embedded-scene fallback (a connect() that
// resolves just past the timeout, or a host that answers the handshake
// slowly), and a host may deliver tool-results more than once. Routing
// every mount through the same callback — which disposes whichever handle
// is currently live and clears the container BEFORE the factory creates
// the next root — is what keeps two React roots from ever competing for
// the same container (createRoot on a container whose children still
// belong to an undisposed root crashes React with a removeChild
// NotFoundError).
async function mountFromHost(
  container: HTMLElement,
  remount: (mount: () => CanvasViewerHandle) => void,
): Promise<boolean> {
  // No parent frame — this document cannot be an embedded MCP Apps view.
  if (window.parent === window) return false

  const app = new App({ name: 'whiteboard-canvas-view', version: '0.0.0' }, {})

  // Committed only once a tool-result has actually passed parseViewerScene —
  // an unvalidated canvasId must never enable Refresh or the sticky-note
  // affordance (either would call back into the daemon with an ID nobody
  // confirmed is real).
  let committedCanvasId: string | undefined
  // Retained so the sticky-note affordance can place a new note relative to
  // the last scene this widget actually rendered, without ever reaching
  // into Excalidraw's own viewport internals (mount.ts stays read-only).
  let lastValidScene: ViewerScene | undefined
  let refreshControl: ReturnType<typeof createRefreshControl> | undefined
  let stickyControl: ReturnType<typeof createStickyNoteControl> | undefined

  const commitResult = (canvasId: string | undefined, scene: ViewerScene): void => {
    lastValidScene = scene
    if (canvasId === undefined) return
    committedCanvasId = canvasId
    refreshControl?.show()
    stickyControl?.show()
  }

  app.ontoolresult = (result) => {
    applyToolResult(result, container, remount, commitResult)
  }

  // connect() may reject after the timeout already won the race; a catch on
  // the race result alone would leave that late rejection unhandled.
  const connected = await Promise.race([
    app
      .connect()
      .then(() => true)
      .catch(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), HOST_CONNECT_TIMEOUT_MS)),
  ])

  // A successful handshake alone does not guarantee the host can proxy tool
  // calls back to the server — only app.getHostCapabilities()?.serverTools
  // does (per the ext-apps host-capability negotiation). Creating Refresh
  // without this check would show a control whose every click silently
  // fails on hosts that never advertised the capability.
  const canUseServerTools = app.getHostCapabilities()?.serverTools !== undefined

  // Only ever reveal Refresh when THIS race decided "connected" AND the host
  // advertised serverTools — a tool-result can legitimately arrive (and
  // mount) before the timeout wins the race, but that must not resurrect
  // Refresh once "not connected" has been decided, even if app.connect()
  // itself resolves later. Deciding once here, rather than re-checking on
  // every later event, is what keeps that outcome permanent for the rest of
  // this document's lifetime.
  if (connected && canUseServerTools) {
    let refreshInFlight = false
    // Set whenever a refresh is REQUIRED while one is already in flight (a
    // manual Refresh click racing a just-succeeded annotate, or vice versa)
    // — the in-flight run loops once more instead of the caller's request
    // being silently dropped. A single boolean (rather than a queue) is
    // enough because every refresh call targets the same committedCanvasId
    // and asks for the same thing: "the latest scene".
    let pendingRefresh = false

    const runRefreshOnce = async (): Promise<void> => {
      if (committedCanvasId === undefined) return
      try {
        const result = await app.callServerTool({
          name: 'canvas_view',
          arguments: { canvasId: committedCanvasId },
        })
        applyToolResult(result, container, remount, commitResult)
      } catch (err) {
        // Network/host failure: the current view stays mounted (no remount
        // was attempted) — nothing to recover here besides resetting the
        // in-flight guard below. Logged so a failing host transport doesn't
        // present as a dead button.
        console.error('[whiteboard-widget] refresh via host callServerTool failed:', err)
      }
    }

    const performRefresh = async (): Promise<void> => {
      if (committedCanvasId === undefined) return
      if (refreshInFlight) {
        pendingRefresh = true
        return
      }
      refreshInFlight = true
      refreshControl?.setBusy(true)
      try {
        do {
          pendingRefresh = false
          await runRefreshOnce()
        } while (pendingRefresh)
      } finally {
        refreshInFlight = false
        refreshControl?.setBusy(false)
      }
    }

    let annotateInFlight = false
    const performAnnotate = async (text: string): Promise<void> => {
      if (annotateInFlight || committedCanvasId === undefined) return
      annotateInFlight = true
      stickyControl?.setBusy(true)
      const target = computeStickyPlacement(lastValidScene?.nodes ?? [])
      try {
        const result = await app.callServerTool({
          name: 'annotate',
          arguments: {
            canvasId: committedCanvasId,
            type: 'box_with_label',
            target,
            text,
            width: STICKY_WIDTH,
            backgroundColor: STICKY_BACKGROUND_COLOR,
          },
        })
        if (isErrorResult(result)) {
          console.error(
            '[whiteboard-widget] annotate via host callServerTool returned an error result:',
            result,
          )
          return
        }
        // Required, not optional: append-only means the new note is only
        // visible once canvas_view re-fetches. Routed through the same
        // coalescing performRefresh a concurrent manual Refresh uses, so
        // neither call can silently skip the other's refresh. Awaited
        // (rather than fire-and-forget) so the sticky control — and the
        // placement math a rapid next submission would read from
        // lastValidScene — only re-enable once this refresh has actually
        // updated lastValidScene; otherwise a second quick submission could
        // compute its target from the stale pre-annotation scene and land on
        // the same coordinates as the first note.
        await performRefresh()
        // Only after full success — a failed annotate keeps the text so the
        // user can retry without retyping.
        stickyControl?.clear()
      } catch (err) {
        console.error('[whiteboard-widget] annotate via host callServerTool failed:', err)
      } finally {
        annotateInFlight = false
        stickyControl?.setBusy(false)
      }
    }

    refreshControl = createRefreshControl(() => {
      void performRefresh()
    })
    stickyControl = createStickyNoteControl((text) => {
      void performAnnotate(text)
    })

    // A tool-result can commit an ID during connect() above, before either
    // control existed to be shown — reveal both if that already happened.
    if (committedCanvasId !== undefined) {
      refreshControl.show()
      stickyControl.show()
    }
  }

  return connected
}

async function bootstrap(): Promise<void> {
  registerFonts()

  const container = document.getElementById('root')
  if (!container) {
    throw new Error('widget-entry: expected a #root element in the widget HTML shell')
  }

  let handle: CanvasViewerHandle | undefined
  // Order matters: dispose the live root and clear its DOM BEFORE the
  // factory creates the next root — see mountFromHost's doc comment.
  const remount = (mount: () => CanvasViewerHandle): void => {
    handle?.dispose()
    container.replaceChildren()
    handle = mount()
  }
  const connectedToHost = await mountFromHost(container, remount)
  if (!connectedToHost && handle === undefined) {
    // The embedded-scene fallback goes through the same remount path: a
    // slow host can deliver a tool-result mount in the gap between the
    // timeout losing the race and this line, and a bare mountCanvasViewer
    // here would then stack a second root on the container. The handle
    // check keeps a just-arrived host scene instead of replacing it.
    remount(() => mountCanvasViewer(container))
  }
}

void bootstrap()
