// Entry point for the self-contained single-file widget build
// (vite.widget.config.ts -> dist/widget/canvas-viewer.html). Never exported
// from the package's public surface — this file is a build INPUT, loaded
// only by the widget's own <script type="module"> tag.

import { WIDGET_FONTS } from 'virtual:widget-fonts'
import { mdastRootSchema } from '@kamiazya/whiteboard-canvas-model/mdast'
import { App } from '@modelcontextprotocol/ext-apps'
import { z } from 'zod'
import {
  type CanvasViewerHandle,
  type MountCanvasViewerOptions,
  mountCanvasViewer,
} from './mount.js'
import { parseViewerScene, type ViewerScene } from './scene.js'
import { buildFontFaceDescriptors } from './widget/font-registration.js'
import { createRefreshControl } from './widget/refresh-control.js'

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
// the same `{documentId, scene}` shape returned by canvas_view's Zod
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

// TODO(annotate): the add-a-sticky-note affordance is UNWIRED.
//
// It called an `annotate` MCP tool that the OpenCanvas migration removed;
// nothing replaced it, so every submission failed at the host with an
// unknown-tool error while the control still looked live. Showing a control
// that cannot work is worse than not showing one, so the wiring is gone and
// `widget/sticky-note-control.ts` + `widget/sticky-placement.ts` are kept
// unmounted for whoever restores it.
//
// Restoring it needs a decision first, not just re-wiring: OpenCanvas has no
// annotate equivalent, and a sticky note is a `wb_node_add` of a text node —
// so the question is whether this widget should mutate a document at all
// (it is otherwise strictly read-only), and if so under what placement
// rule. `computeStickyPlacement` is the old rule, still tested.
// Both `ui/notifications/tool-result` and the CallToolResult that
// `app.callServerTool` resolves with wrap canvas_view's payload the same
// way: `{structuredContent: {documentId, scene}}`. Sharing one extraction +
// validation path for the initial mount and every refresh keeps the
// malformed-payload defense (parseViewerScene before remount) and the
// documentId commit rule (never commit from a result that failed validation)
// in exactly one place. The envelope crosses the host↔widget process
// boundary, so it gets a Zod schema instead of a cast; `scene` stays
// deliberately unknown here — parseViewerScene is its real validator.
// `references` is validated HERE rather than trusted: it arrives from the
// host, and a malformed entry reaches canvas-render's layout seams as
// whatever the host sent.
//
// Validated against the CANONICAL, fully-recursive `mdastRootSchema` — the
// same schema `canvas_view` declares its payload with server-side — not a
// looser shape check. A root-shaped body with an unrecognised child is not
// something layout shrugs off: `layoutBlock`'s switch has no default case,
// so one bad child throws out of `layoutSpatialCanvas` and takes the whole
// canvas with it. Checking only `{type:'root', children: unknown[]}` here
// and casting past the rest let exactly that through.
//
// Applied PER REFERENCE, so strictness costs only the reference that fails.
const referenceSchema = z.object({
  label: z.string().optional(),
  body: mdastRootSchema.optional(),
})

/** Keeps the references that parse, drops the ones that do not. */
function parseReferences(raw: Record<string, unknown> | undefined) {
  if (raw === undefined) return undefined
  const kept: Record<string, z.infer<typeof referenceSchema>> = {}
  for (const [ref, value] of Object.entries(raw)) {
    const parsed = referenceSchema.safeParse(value)
    if (parsed.success) kept[ref] = parsed.data
    else console.error('[whiteboard-widget] dropping unparseable reference:', ref, parsed.error)
  }
  return Object.keys(kept).length > 0 ? kept : undefined
}

const toolResultEnvelopeSchema = z.object({
  structuredContent: z
    .object({
      documentId: z.string().optional(),
      scene: z.unknown().optional(),
      // Deliberately `unknown` HERE, then parsed per entry below. Putting
      // the strict schema inline would make one bad reference fail the
      // whole envelope, discarding a perfectly good scene along with it —
      // the widget would go blank because a document it merely POINTS AT
      // was malformed.
      references: z.record(z.string(), z.unknown()).optional(),
    })
    .catchall(z.unknown())
    .optional(),
})

function extractCanvasIdAndScene(payload: unknown): {
  documentId?: string
  scene?: unknown
  references?: MountCanvasViewerOptions['references']
} {
  const parsed = toolResultEnvelopeSchema.safeParse(payload)
  if (!parsed.success) return {}
  const structuredContent = parsed.data.structuredContent
  return {
    documentId: structuredContent?.documentId,
    scene: structuredContent?.scene,
    references: parseReferences(structuredContent?.references),
  }
}

// Validates BEFORE remount: remount disposes the live viewer first, so a
// malformed payload would otherwise trade a working view for an empty
// container. `onValidResult` only fires once parseViewerScene has actually
// accepted the scene, which is what lets the documentId commit rule ("never
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
  onValidResult: (documentId: string | undefined, scene: ViewerScene) => void,
): void {
  if (isErrorResult(payload)) {
    console.error('[whiteboard-widget] ignoring tool-result carrying an error result:', payload)
    return
  }
  const { documentId, scene, references } = extractCanvasIdAndScene(payload)
  const result = parseViewerScene(scene)
  if (!result.ok) {
    // Surfaced for host-integration debugging: the widget deliberately
    // keeps the current view on malformed payloads, which would otherwise
    // make a host sending the wrong shape look like a silent no-op.
    console.error('[whiteboard-widget] ignoring tool-result with invalid scene:', result.error)
    return
  }
  // References ride along with the scene: a file node pointing at a
  // markdown document renders that document's prose only if the server put
  // it in the payload, since this widget has no store to read it from.
  remount(() =>
    mountCanvasViewer(container, {
      scene,
      ...(references === undefined ? {} : { references }),
    }),
  )
  onValidResult(documentId, result.value)
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
  // an unvalidated documentId must never enable Refresh or the sticky-note
  // affordance (either would call back into the daemon with an ID nobody
  // confirmed is real).
  let committedCanvasId: string | undefined
  let refreshControl: ReturnType<typeof createRefreshControl> | undefined

  // `scene` is unused now that the sticky-note affordance is unwired (see
  // the TODO(annotate) note above — it placed a new note relative to the
  // last rendered scene). The parameter stays because `applyToolResult`
  // hands it over as part of the "only commit from a VALIDATED result"
  // contract, which is what this callback exists to enforce.
  const commitResult = (documentId: string | undefined, _scene: ViewerScene): void => {
    if (documentId === undefined) return
    committedCanvasId = documentId
    refreshControl?.show()
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
          arguments: { documentId: committedCanvasId },
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

    refreshControl = createRefreshControl(() => {
      void performRefresh()
    })
    // A tool-result can commit an ID during connect() above, before the
    // control existed to be shown — reveal it if that already happened.
    if (committedCanvasId !== undefined) {
      refreshControl.show()
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
