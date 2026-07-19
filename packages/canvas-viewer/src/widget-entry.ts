// Entry point for the self-contained single-file widget build
// (vite.widget.config.ts -> dist/widget/canvas-viewer.html). Never exported
// from the package's public surface — this file is a build INPUT, loaded
// only by the widget's own <script type="module"> tag.
import { App } from '@modelcontextprotocol/ext-apps'
import { z } from 'zod'
import { FONT_FILENAME_MAP, WIDGET_FONTS } from 'virtual:widget-fonts'
import { mountCanvasViewer, type CanvasViewerHandle } from './mount.js'
import { parseViewerScene } from './scene.js'
import { buildFontFaceDescriptors, resolveFontFetchDataUri } from './widget/font-registration.js'
import { createRefreshControl } from './widget/refresh-control.js'

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string
    // Guarded debug hook, not a public API: exposes exactly the FontFace
    // instances THIS module registered (as opposed to the placeholder
    // FontFace entries Excalidraw's own font manager adds to
    // `document.fonts` for every font variant it knows about, whether or
    // not this build embedded it). The widget-smoke script is the only
    // reader — without this, "is Excalifont loaded" is ambiguous because
    // Excalidraw's own unrelated placeholders share the same family name.
    __whiteboardWidgetFonts__?: readonly FontFace[]
    // Pre-set by the smoke harness (init script) to opt into the hook above.
    __WHITEBOARD_WIDGET_DEBUG__?: boolean
  }
}

// Registers every embedded font via the FontFace API and injects matching
// @font-face rules, both pointing at the same base64 data URI. Doing this
// BEFORE Excalidraw mounts means its own font-manager finds each family
// already present in `document.fonts` and never has to resolve
// EXCALIDRAW_ASSET_PATH for the families this build knows about.
function registerFonts(): void {
  const rules: string[] = []
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
      // leave Excalidraw to render a fallback glyph with no visible error.
    })

    const rangeRule = font.unicodeRange ? ` unicode-range: ${font.unicodeRange};` : ''
    rules.push(
      `@font-face { font-family: ${JSON.stringify(font.family)}; src: url(${font.dataUri}) format("woff2");${rangeRule} }`,
    )
  }

  const style = document.createElement('style')
  style.textContent = rules.join('\n')
  document.head.appendChild(style)
  // Smoke-only instrumentation: only populated when the harness pre-sets
  // the debug flag (via an init script, before this entry runs). The
  // production widget never retains the FontFace list.
  if (window.__WHITEBOARD_WIDGET_DEBUG__ === true) {
    window.__whiteboardWidgetFonts__ = registeredFaces
  }

  // EXCALIDRAW_ASSET_PATH must be a string; Excalidraw resolves any font URL
  // it still needs (one this build didn't anticipate) against it. The exact
  // value is inert (the fetch shim intercepts before the network), but
  // constructing it must not throw: MCP Apps hosts load this widget via a
  // sandboxed srcdoc iframe where location.href is the non-URL
  // "about:srcdoc" and `new URL('.', location.href)` throws, killing the
  // whole bootstrap. document.baseURI (inherited from the embedding
  // document in srcdoc) usually works; a fixed inert prefix is the final
  // fallback.
  window.EXCALIDRAW_ASSET_PATH = resolveInertAssetPrefix()
}

const INERT_ASSET_PREFIX_FALLBACK = 'https://whiteboard-widget.invalid/'

function resolveInertAssetPrefix(): string {
  // document.baseURI (inherited from the embedding document in srcdoc) usually
  // works when location.href is the non-URL "about:srcdoc"; the fixed inert
  // prefix is the final fallback if both bases fail to resolve.
  for (const base of [window.location.href, document.baseURI]) {
    try {
      return new URL('.', base).toString()
    } catch {
      // Non-URL base (e.g. "about:srcdoc") throws; try the next candidate.
    }
  }
  return INERT_ASSET_PREFIX_FALLBACK
}

// Scoped fallback for the case Excalidraw's lazy font loader still issues a
// `fetch()` for one of the filenames above (e.g. it re-resolves the URL
// itself rather than reusing the pre-registered FontFace). Known embedded
// font filenames are served from the inline data URIs; a request for any
// OTHER font file (a family/subset this bundle does not embed — e.g. CJK
// glyph subsets) gets a deterministic synthetic 404 so the widget degrades
// to system-font fallback glyphs offline instead of attempting a network
// fetch the host's sandbox would block anyway. Non-font requests fall
// through to the real fetch unchanged, so this can never mask an
// unrelated network call.
const FONT_FILE_RE = /\.(?:woff2?|ttf|otf)(?:[?#]|$)/i

function requestUrlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function installFontFetchShim(): void {
  const originalFetch = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const dataUri = resolveFontFetchDataUri(input, FONT_FILENAME_MAP)
    if (dataUri) {
      return originalFetch(dataUri, init)
    }
    if (FONT_FILE_RE.test(requestUrlOf(input))) {
      return Promise.resolve(new Response(null, { status: 404, statusText: 'Not Found' }))
    }
    return originalFetch(input, init)
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
function applyToolResult(
  payload: unknown,
  container: HTMLElement,
  remount: (mount: () => CanvasViewerHandle) => void,
  onValidResult: (canvasId: string | undefined) => void,
): void {
  const { canvasId, scene } = extractCanvasIdAndScene(payload)
  try {
    parseViewerScene(scene)
  } catch (err) {
    // Surfaced for host-integration debugging: the widget deliberately
    // keeps the current view on malformed payloads, which would otherwise
    // make a host sending the wrong shape look like a silent no-op.
    console.error('[whiteboard-widget] ignoring tool-result with invalid scene:', err)
    return
  }
  remount(() => mountCanvasViewer(container, { scene }))
  onValidResult(canvasId)
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
  // an unvalidated canvasId must never enable Refresh (it would call
  // canvas_view with an ID nobody confirmed is real).
  let committedCanvasId: string | undefined
  let refreshControl: ReturnType<typeof createRefreshControl> | undefined

  const rememberCanvasId = (canvasId: string | undefined): void => {
    if (canvasId === undefined) return
    committedCanvasId = canvasId
    refreshControl?.show()
  }

  app.ontoolresult = (result) => {
    applyToolResult(result, container, remount, rememberCanvasId)
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
    refreshControl = createRefreshControl(() => {
      if (refreshInFlight || committedCanvasId === undefined) return
      refreshInFlight = true
      refreshControl?.setBusy(true)
      void app
        .callServerTool({ name: 'canvas_view', arguments: { canvasId: committedCanvasId } })
        .then((result) => {
          applyToolResult(result, container, remount, rememberCanvasId)
        })
        .catch((err) => {
          // Network/host failure: the current view stays mounted (no
          // remount was attempted) — nothing to recover here besides
          // resetting the in-flight guard below. Logged so a failing
          // host transport doesn't present as a dead button.
          console.error('[whiteboard-widget] refresh via host callServerTool failed:', err)
        })
        .finally(() => {
          refreshInFlight = false
          refreshControl?.setBusy(false)
        })
    })
    if (committedCanvasId !== undefined) {
      refreshControl.show()
    }
  }

  return connected
}

async function bootstrap(): Promise<void> {
  registerFonts()
  installFontFetchShim()

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
