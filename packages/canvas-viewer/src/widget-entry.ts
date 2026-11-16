// Entry point for the self-contained single-file widget build
// (vite.widget.config.ts -> dist/widget/canvas-viewer.html). Never exported
// from the package's public surface — this file is a build INPUT, loaded
// only by the widget's own <script type="module"> tag.

import { WIDGET_FONTS } from 'virtual:widget-fonts'
import {
  type CanvasViewPicture,
  canvasViewPictureSchema,
  pictureNodeAt,
  type SpatialRenderStyle,
} from '@kamiazya/whiteboard-canvas-render/canvas-view-picture'
import { App } from '@modelcontextprotocol/ext-apps'
import { dataUriToBytes } from './font-loading.js'
import { canvasPointFromClick } from './widget/canvas-point.js'
import { readCanvasViewResult } from './widget/canvas-view-result.js'
import { createCommentControl } from './widget/comment-control.js'
import { buildFontFaceDescriptors } from './widget/font-registration.js'
import {
  mountPicture,
  type PictureHandle,
  pictureDeclaresFamily,
  pictureSvgElement,
} from './widget/picture-view.js'
import { createRefreshControl } from './widget/refresh-control.js'
import { guardSceneLinks, type SceneLinkGuard } from './widget/scene-links.js'
import { loadThemeFont } from './widget/theme-font.js'
import { toolErrorText } from './widget/tool-error-text.js'
import { canvasViewCall, threadAddCall } from './widget/widget-tool-calls.js'

declare global {
  interface Window {
    // Guarded debug hook, not a public API: exposes exactly the FontFace
    // instances THIS module registered. The widget-smoke script is the only
    // reader.
    __whiteboardWidgetFonts__?: readonly FontFace[]
    // Pre-set by the smoke harness (init script) to opt into the hook above.
    __WHITEBOARD_WIDGET_DEBUG__?: boolean
    // Guarded debug hook, not a public API: feeds one canvas_view result
    // through the same path a host's `ui/notifications/tool-result` takes,
    // so the widget-smoke can exercise the built bundle without standing up
    // an MCP Apps host. Only set when the flag above is.
    __whiteboardWidgetToolResult__?: (payload: unknown) => void
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
    // From BYTES, not `url(${font.dataUri})`. A `url()` source is a fetch as
    // far as CSP is concerned and so is subject to `font-src`, which an MCP
    // Apps host builds from `_meta.ui.csp.resourceDomains` — a list of
    // origins that cannot name `data:`. See `dataUriToBytes` for what that
    // measured. A buffer source is not a fetch and no directive governs it.
    const face = new FontFace(font.family, dataUriToBytes(font.dataUri), descriptors)
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
// result via `ui/notifications/tool-result`: `structuredContent` carries the
// ids and the look the result was drawn under, and `_meta` the picture the
// daemon laid out (`canvasViewPictureSchema`), which is all this widget
// draws. It never receives daemon credentials — only that result plus, once
// connected, the host's own MCP session — so its
// only outbound path is re-invoking canvas_view through
// `app.callServerTool`, which is what the Refresh control below does; there
// is no direct daemon access from this document.
//
// When no ext-apps host is embedding this document (e.g. the widget opened
// directly in a browser, or the widget-smoke harness), `app.connect()`
// never resolves because no PostMessageTransport peer answers on the other
// end — `mountFromHost` races that against `HOST_CONNECT_TIMEOUT_MS` below
// so bootstrap always falls back to the embedded-picture slot instead of
// hanging forever.
const HOST_CONNECT_TIMEOUT_MS = 2_000

// Whether a result is an application-level failure rather than a
// transport-level rejection: the ext-apps host resolves (never rejects) a
// server-side tool handler exception as `{isError: true}` — treating that as
// success would remount on a failed comment write's error payload or skip
// the refresh that has to follow a comment write.
function isErrorResult(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { isError?: unknown }).isError === true
  )
}

/**
 * The delivery half (ADR-0024 decision 5): where the host accepts
 * `ui/message`, inject the comment into the conversation as a user-role
 * message so the model responds to the feedback NOW.
 *
 * Fire-and-forget with its own catch — the comment is already in the
 * document, and a host that refuses the wake-up only delays the model to
 * its next read.
 */
function announceComment(
  app: {
    getHostCapabilities: () => { message?: unknown } | undefined
    sendMessage: (message: {
      role: 'user'
      content: { type: 'text'; text: string }[]
    }) => Promise<unknown>
  },
  anchor: { x: number; y: number; targetNodeId?: string },
  text: string,
): void {
  if (app.getHostCapabilities()?.message === undefined) return
  // A node id is chosen by whoever wrote the document, and a user-role
  // message would present it as the user's own words, so the node is named
  // by position only. The comment written to the document keeps its target.
  const where =
    anchor.targetNodeId === undefined
      ? `at (${anchor.x}, ${anchor.y})`
      : `on a node at (${anchor.x}, ${anchor.y})`
  void app
    .sendMessage({
      role: 'user',
      content: [
        {
          type: 'text',
          text: `The user pinned a comment on the canvas ${where}: "${text}". Please take a look at the canvas and respond to the comment.`,
        },
      ],
    })
    .catch((err) => {
      console.error('[whiteboard-widget] comment sendMessage failed:', err)
    })
}

type OnValidResult = (
  workspaceId: string | undefined,
  documentId: string | undefined,
  picture: CanvasViewPicture,
  style: SpatialRenderStyle | undefined,
) => void

type Remount = (mount: () => PictureHandle) => void

// What the person reads when a failure brings no reason of its own: a
// rejected host call, or a result the server answered without text. Both
// land on the comment control's alert line — the widget's one status line,
// present whenever Refresh is, behind the same gate.
const COMMENT_NOT_SENT = 'The comment could not be sent. Your text and spot are kept; try again.'
const CANVAS_NOT_REFRESHED = 'The canvas could not be refreshed. This is the last copy that loaded.'

/** The reason a result that did not apply gives, or `fallback` when it gives none. */
function failureReason(result: unknown, fallback: string): string {
  return (isErrorResult(result) ? toolErrorText(result) : undefined) ?? fallback
}

// The initial tool-result and every refresh response arrive in the same
// envelope, so one path applies both and holds the malformed-payload defense
// and the id commit rule in one place. It validates BEFORE remount: remount
// disposes the live view first, so a malformed payload would otherwise
// trade a working view for an empty container. `onValidResult` fires only
// once the picture has been read and checked, which is what keeps ids from
// an unvalidated result from ever being committed. Reading the envelope
// itself is `readCanvasViewResult`'s job.
function applyToolResult(
  payload: unknown,
  container: HTMLElement,
  remount: Remount,
  onValidResult: OnValidResult,
): boolean {
  if (isErrorResult(payload)) {
    console.error('[whiteboard-widget] ignoring tool-result carrying an error result:', payload)
    return false
  }
  const { workspaceId, documentId, picture, style, themeFont } = readCanvasViewResult(payload)
  const element = picture === undefined ? undefined : pictureSvgElement(picture.svg)
  if (picture === undefined || element === undefined) {
    // Surfaced for host-integration debugging: the widget deliberately
    // keeps the current view on malformed payloads, which would otherwise
    // make a host sending the wrong shape look like a silent no-op.
    console.error('[whiteboard-widget] ignoring tool-result with no drawable picture:', payload)
    return false
  }
  remount(() => mountPicture(container, element))
  onValidResult(workspaceId, documentId, picture, style)
  // The widget's one exception to its zero-network rule (ADR-0011's
  // 2026-09-10 note): a theme's family, from the pinned catalogue origin,
  // only while drawing that theme, and only when the picture actually names
  // it — the daemon declares a family only where it measured with it. The
  // picture is already on screen; once the face loads the browser repaints
  // its text in it, so this is never a gate and never a redraw.
  if (
    themeFont !== undefined &&
    style !== undefined &&
    style !== 'clean' &&
    pictureDeclaresFamily(element, themeFont.family)
  ) {
    void loadThemeFont(themeFont)
  }
  return true
}

/**
 * The comment anchor a click at `point` picks, and how the form names it: the
 * node the click landed on is its target, so the pin follows that node.
 */
function pickAnchor(
  picture: CanvasViewPicture | undefined,
  point: { readonly x: number; readonly y: number },
): { anchor: { x: number; y: number; targetNodeId?: string }; label: string } {
  const target = picture === undefined ? undefined : pictureNodeAt(picture, point)
  const where = `(${point.x}, ${point.y})`
  return target === undefined
    ? { anchor: { ...point }, label: where }
    : { anchor: { ...point, targetNodeId: target }, label: `${target} ${where}` }
}

// `remount` is the single place a mount produced by this bridge happens.
// `app.connect()` racing HOST_CONNECT_TIMEOUT_MS means a tool-result can
// legitimately arrive AFTER the caller already decided `connectedToHost`
// was false and mounted its own embedded-picture fallback (a connect() that
// resolves just past the timeout, or a host that answers the handshake
// slowly), and a host may deliver tool-results more than once. Routing
// every mount through the same callback — which disposes whichever view is
// live and clears the container BEFORE the factory places the next — is
// what keeps two pictures from ever stacking in one container.
async function mountFromHost(
  container: HTMLElement,
  remount: Remount,
  links: SceneLinkGuard,
): Promise<boolean> {
  // No parent frame — this document cannot be an embedded MCP Apps view.
  if (window.parent === window) return false

  const app = new App({ name: 'whiteboard-canvas-view', version: '0.0.0' }, {})

  // Committed only once a tool-result's picture has been read and checked —
  // unvalidated ids must never enable Refresh or the comment affordance
  // (either would call back into the daemon with ids nobody confirmed are
  // real). BOTH ids, because every follow-up call's strict input schema
  // requires the workspaceId alongside the documentId — a result carrying
  // only one of them enables nothing.
  //
  // `style` is the look the latest result was drawn under: every refresh asks
  // for it again, since `canvas_view` answers the bundled look to a call that
  // names none.
  let committed: { workspaceId: string; documentId: string; style?: SpatialRenderStyle } | undefined
  // The shown picture, kept for click-to-anchor hit-testing: a click inside
  // a node's stored box names that node as the comment's target, so the pin
  // follows the node rather than the spot it happened to occupy.
  let committedPicture: CanvasViewPicture | undefined
  let refreshControl: ReturnType<typeof createRefreshControl> | undefined
  let commentControl: ReturnType<typeof createCommentControl> | undefined

  const commitResult: OnValidResult = (workspaceId, documentId, picture, style) => {
    if (workspaceId === undefined || documentId === undefined) return
    committed = { workspaceId, documentId, ...(style === undefined ? {} : { style }) }
    committedPicture = picture
    refreshControl?.show()
    commentControl?.show()
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
  if (connected) links.openThrough(app)

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
    // manual Refresh click racing a just-succeeded comment write, or vice versa)
    // — the in-flight run loops once more instead of the caller's request
    // being silently dropped. A single boolean (rather than a queue) is
    // enough because every refresh call targets the same `committed` ids
    // and asks for the same thing: "the latest scene".
    let pendingRefresh = false

    const runRefreshOnce = async (): Promise<void> => {
      if (committed === undefined) return
      try {
        const result = await app.callServerTool(canvasViewCall(committed))
        const applied = applyToolResult(result, container, remount, commitResult)
        commentControl?.setError(applied ? undefined : failureReason(result, CANVAS_NOT_REFRESHED))
      } catch (err) {
        // Host failure: nothing was remounted, so the last view stays.
        console.error('[whiteboard-widget] refresh via host callServerTool failed:', err)
        commentControl?.setError(CANVAS_NOT_REFRESHED)
      }
    }

    const performRefresh = async (): Promise<void> => {
      if (committed === undefined) return
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

    // The anchor the next submit pins its comment at. Set by clicking the
    // canvas, cleared on a successful submit so the next comment has to
    // point at its own spot.
    let pendingAnchor: { x: number; y: number; targetNodeId?: string } | undefined

    // The widget's ONE write: a thread opened at the clicked anchor
    // (ADR-0026). The input clears on WRITE success rather than after the
    // follow-up refresh: once the edit is committed server-side, keeping
    // the text would invite a duplicate resubmit if only the refresh
    // failed; a refused or failed write keeps text AND anchor for retry.
    const submitComment = async (text: string): Promise<void> => {
      if (committed === undefined || pendingAnchor === undefined) return
      const anchor = pendingAnchor
      commentControl?.setBusy(true)
      try {
        const result = await app.callServerTool(threadAddCall(committed, anchor, text))
        if (isErrorResult(result)) {
          commentControl?.setError(failureReason(result, COMMENT_NOT_SENT))
          return
        }
        commentControl?.clear()
        commentControl?.setAnchor(undefined)
        pendingAnchor = undefined
        announceComment(app, anchor, text)
        await performRefresh()
      } catch (err) {
        console.error('[whiteboard-widget] comment via host failed:', err)
        commentControl?.setError(COMMENT_NOT_SENT)
      } finally {
        commentControl?.setBusy(false)
      }
    }
    commentControl = createCommentControl((text) => {
      void submitComment(text)
    })

    // Click-to-anchor: any click on the rendered SVG picks the comment's
    // anchor point; a click inside a node's stored box also names it as the
    // target. Delegated from the container because remount replaces the SVG
    // element itself on every refresh.
    container.addEventListener('click', (event) => {
      if (commentControl === undefined) return
      const svg = container.querySelector('svg')
      if (!(svg instanceof SVGSVGElement)) return
      const point = canvasPointFromClick(svg, event.clientX, event.clientY)
      if (point === undefined) return
      const picked = pickAnchor(committedPicture, point)
      pendingAnchor = picked.anchor
      commentControl.setAnchor(picked.label)
    })

    // A tool-result can commit ids during connect() above, before the
    // controls existed to be shown — reveal them if that already happened.
    if (committed !== undefined) {
      refreshControl.show()
      commentControl.show()
    }
  }

  return connected
}

const EMBEDDED_PICTURE_SELECTOR = 'script[type="application/json"][data-whiteboard-picture]'

/**
 * The picture a document that is not hosted shows: the shell's
 * `<script data-whiteboard-picture>` slot, which a step serving the file
 * directly fills (`serializeForScriptTag`). Nothing drawable there leaves the
 * splash, and says why.
 */
function readEmbeddedPicture(): SVGSVGElement | undefined {
  const text = document.querySelector(EMBEDDED_PICTURE_SELECTOR)?.textContent ?? ''
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (err) {
    console.error('[whiteboard-widget] embedded picture is not JSON:', err)
    return undefined
  }
  const picture = canvasViewPictureSchema.safeParse(value)
  const element = picture.success ? pictureSvgElement(picture.data.svg) : undefined
  if (element === undefined) console.error('[whiteboard-widget] embedded picture is not drawable')
  return element
}

async function bootstrap(): Promise<void> {
  registerFonts()

  const container = document.getElementById('root')
  if (!container) {
    throw new Error('widget-entry: expected a #root element in the widget HTML shell')
  }

  const links = guardSceneLinks(container)
  let handle: PictureHandle | undefined
  // Order matters: dispose the live view and clear its DOM BEFORE the
  // factory places the next one — see mountFromHost's doc comment.
  const remount: Remount = (mount) => {
    handle?.dispose()
    container.replaceChildren()
    handle = mount()
  }
  // Smoke-only instrumentation, on the same flag registerFonts() reads: the
  // widget-smoke drives the BUILT bundle over file://, where no MCP Apps
  // host answers the handshake, and a payload-shaped path is the only way to
  // exercise what a tool-result does there. The production widget never
  // exposes it.
  if (window.__WHITEBOARD_WIDGET_DEBUG__ === true) {
    window.__whiteboardWidgetToolResult__ = (payload: unknown) => {
      applyToolResult(payload, container, remount, () => {})
    }
  }

  const connectedToHost = await mountFromHost(container, remount, links)
  if (!connectedToHost && handle === undefined) {
    // The embedded-picture fallback goes through the same remount path: a
    // slow host can deliver a tool-result in the gap between the timeout
    // losing the race and this line, and a bare mount here would then stack
    // a second view in the container. The handle check keeps a just-arrived
    // host picture instead of replacing it.
    const element = readEmbeddedPicture()
    if (element !== undefined) remount(() => mountPicture(container, element))
  }
}

void bootstrap()
