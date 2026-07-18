// Entry point for the self-contained single-file widget build
// (vite.widget.config.ts -> dist/widget/canvas-viewer.html). Never exported
// from the package's public surface — this file is a build INPUT, loaded
// only by the widget's own <script type="module"> tag.
import { App } from '@modelcontextprotocol/ext-apps'
import { FONT_FILENAME_MAP, WIDGET_FONTS } from 'virtual:widget-fonts'
import { mountCanvasViewer, type CanvasViewerHandle } from './mount.js'
import { buildFontFaceDescriptors, resolveFontFetchDataUri } from './widget/font-registration.js'

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
  // it still needs (one this build didn't anticipate) against it. Since
  // this document is the only thing that prefix could ever point at, and
  // the fetch shim below intercepts requests before they reach the
  // network, the exact value is inert.
  window.EXCALIDRAW_ASSET_PATH = new URL('.', window.location.href).toString()
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
// scene snapshot — so it cannot call anything back into the daemon
// directly (the only outbound path, when a host supports it, is
// re-invoking canvas_view through the host's own MCP session, which this
// Phase-A bootstrap does not yet do; there is no Refresh action here).
//
// When no ext-apps host is embedding this document (e.g. the widget opened
// directly in a browser, or the widget-smoke harness), `app.connect()`
// never resolves because no PostMessageTransport peer answers on the other
// end — `mountFromHost` races that against `hasHostContext` timeout below
// so bootstrap always falls back to mountCanvasViewer's own embedded-scene
// slot instead of hanging forever.
const HOST_CONNECT_TIMEOUT_MS = 2_000

// `onMount` is the single place a handle produced by this bridge gets
// recorded. `app.connect()` racing HOST_CONNECT_TIMEOUT_MS means a
// tool-result can legitimately arrive AFTER the caller already decided
// `connectedToHost` was false and mounted its own embedded-scene fallback
// (a connect() that resolves just past the timeout, or a host that answers
// the handshake slowly). Routing every mount through the same callback lets
// the caller dispose whichever handle — fallback or a previous tool-result
// — is currently live before mounting the new one, so two React roots never
// compete for the same container.
async function mountFromHost(
  container: HTMLElement,
  onMount: (handle: CanvasViewerHandle) => void,
): Promise<boolean> {
  // No parent frame — this document cannot be an embedded MCP Apps view.
  if (window.parent === window) return false

  const app = new App({ name: 'whiteboard-canvas-view', version: '0.0.0' }, {})

  app.ontoolresult = (result) => {
    // canvas_view's outputSchema wraps the scene as {canvasId, scene}; only
    // the `scene` field matches parseViewerScene's strict {elements,
    // appState?, files?} contract, so the wrapper itself must never reach
    // mountCanvasViewer.
    const structuredContent = (result as { structuredContent?: { scene?: unknown } })
      .structuredContent
    onMount(mountCanvasViewer(container, { scene: structuredContent?.scene }))
  }

  const connected = await Promise.race([
    app.connect().then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), HOST_CONNECT_TIMEOUT_MS)),
  ]).catch(() => false)

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
  const connectedToHost = await mountFromHost(container, (newHandle) => {
    handle?.dispose()
    handle = newHandle
  })
  if (!connectedToHost) {
    handle = mountCanvasViewer(container)
  }
}

void bootstrap()
