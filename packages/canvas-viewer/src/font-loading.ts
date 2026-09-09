// Loads the vendored Roboto face (the exact bytes mcp-server's opentype.js
// exporter measures) as a real webfont, so the browser's Canvas 2D
// `measureText` and the Node export pipeline agree on line breaks and
// content sizing. Without this, `document.fonts` never contains the face,
// Canvas 2D silently falls back to a system font, and the editor's on-screen
// layout diverges from what a user exports (see font.ts's doc comment).

// Vite's `?url` asset suffix, resolved at build/dev-server time.
import robotoFontUrl from '../assets/fonts/Roboto/Roboto-Regular.ttf?url'
import { VIEWER_FONT_FAMILY } from './font.js'

export type ViewerFontStatus = 'loaded' | 'degraded'

// A first-paint budget, not a network timeout: if the vendored face has not
// finished loading by this point, first paint proceeds with fallback
// system-font metrics rather than blocking indefinitely on a stalled fetch.
// A late-resolving load still ticks the readiness signal once more (see
// subscribeViewerFontReady) so an already-mounted consumer re-measures with
// the real face instead of staying wrong for the rest of the session.
export const VIEWER_FONT_LOAD_TIMEOUT_MS = 3000

// Module-scope memoization: N callers share exactly one FontFace
// registration, one fetch, and one settle — never re-registers the face.
let fontLoadPromise: Promise<ViewerFontStatus> | undefined

// Identifies the in-flight load, so a late-arriving result only ever
// rewrites the memoized promise it actually belongs to — a load orphaned by
// resetViewerFontLoadingForTests must not resurrect itself into the next run.
let loadGeneration = 0

const readySubscribers = new Set<() => void>()

function notifyReady(): void {
  for (const callback of readySubscribers) callback()
}

/**
 * The document's face set on a window, the worker global's on a worker.
 *
 * A worker has no `document`, and checking for one is how this module used to
 * decide it was not in a browser at all — which is right up until layout runs
 * off the main thread, where returning 'degraded' means the worker measures
 * with fallback metrics while the window measures with the real face. Two
 * different scenes for the same canvas is worse than a slow one, and it is
 * the same divergence class font.ts's doc comment exists to prevent.
 *
 * `document` is checked first because a window has both: `document.fonts` is
 * the one that governs what a `HTMLCanvasElement` 2D context measures.
 */
function resolveFontFaceSet(): FontFaceSet | undefined {
  if (typeof document !== 'undefined' && document.fonts !== undefined) return document.fonts
  return (globalThis as { fonts?: FontFaceSet }).fonts
}

/**
 * Whether a family a theme names can be MEASURED in this realm, which is
 * the question layout's `fontAvailable` seam asks (ADR-0030 decision 9):
 * the vendored family always, since it is what layout measures with by
 * default; any other only while this realm holds a loaded face for it.
 * A family only the operating system provides answers false — Canvas 2D
 * would draw it, but an export of the same canvas could not, and a face
 * the two sides disagree on puts every wrapped line somewhere else.
 */
export function hasLoadedFace(family: string): boolean {
  if (family === VIEWER_FONT_FAMILY) return true
  // A face this module registered from bytes and saw load: answered from
  // the record rather than by scanning, since a face set is not iterable
  // in every realm that can still register one.
  if (loadedByBytes.has(family)) return true
  const faceSet = resolveFontFaceSet()
  if (faceSet === undefined || typeof faceSet[Symbol.iterator] !== 'function') return false
  for (const face of faceSet) {
    // A face constructed as `"Patrick Hand"` reports its family with the
    // quotes it was given; the theme names it bare.
    if (face.family.replace(/^["']|["']$/g, '') === family && face.status === 'loaded') {
      return true
    }
  }
  return false
}

/**
 * Faces registered from BYTES in this realm, by family — a theme's family
 * the daemon holds and the app fetched (ADR-0012's browser half, for the
 * families a theme names). Memoised per family: two surfaces asking for
 * the same face register it once and share the settle.
 */
const registeredByBytes = new Map<string, Promise<ViewerFontStatus>>()
const loadedByBytes = new Set<string>()

/**
 * Registers a face from its bytes in this realm's face set — the document's
 * on a window, the worker global's on a worker — and resolves once it is
 * usable, so `hasLoadedFace(family)` answers true from then on. Never
 * rejects: a realm without `FontFace`, or bytes that are not a font, answer
 * `'degraded'` and the layout keeps declaring the bundled family.
 */
export function registerFontBytes(family: string, bytes: ArrayBuffer): Promise<ViewerFontStatus> {
  const existing = registeredByBytes.get(family)
  if (existing !== undefined) return existing
  const pending = (async (): Promise<ViewerFontStatus> => {
    const faceSet = resolveFontFaceSet()
    if (typeof FontFace === 'undefined' || faceSet === undefined) return 'degraded'
    try {
      const face = new FontFace(family, bytes)
      faceSet.add(face)
      await face.load()
      loadedByBytes.add(family)
      return 'loaded'
    } catch {
      return 'degraded'
    }
  })()
  registeredByBytes.set(family, pending)
  // A face that did not load is forgotten, so the next pass — after an
  // install, say — registers afresh instead of answering the old failure.
  void pending.then((status) => {
    if (status !== 'loaded') registeredByBytes.delete(family)
  })
  return pending
}

/** Whether this realm can register the vendored face at all. */
export function canLoadViewerFont(): boolean {
  return typeof FontFace !== 'undefined' && resolveFontFaceSet() !== undefined
}

async function loadViewerFont(generation: number): Promise<ViewerFontStatus> {
  // Totality: an environment with no FontFace constructor and no face set (a
  // non-browser test runner, or a browser lacking the API) degrades instead
  // of throwing — the caller always gets a value.
  const faceSet = resolveFontFaceSet()
  if (typeof FontFace === 'undefined' || faceSet === undefined) {
    return 'degraded'
  }

  let face: FontFace
  try {
    face = new FontFace(VIEWER_FONT_FAMILY, `url(${robotoFontUrl})`)
    faceSet.add(face)
  } catch {
    return 'degraded'
  }

  const loadResult: Promise<ViewerFontStatus> = face.load().then(
    () => 'loaded',
    () => 'degraded',
  )

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'timeout'>((resolve) => {
    timeoutHandle = setTimeout(() => resolve('timeout'), VIEWER_FONT_LOAD_TIMEOUT_MS)
  })

  const settled = await Promise.race([loadResult, timedOut])
  // Cleared on whichever path wins — a load that settles before the bound
  // must not leave a pending timer to leak into a fake-timer test teardown.
  clearTimeout(timeoutHandle)

  if (settled === 'timeout') {
    // The face may still finish loading after this function already
    // resolved 'degraded' for first paint. This is the ONE additional tick
    // the readiness signal ever fires — never more, and never again once
    // loadResult itself settles. A late load that *fails* must not tick:
    // subscribers re-measure on a tick, and a tick that does not mean
    // "the real face is now available" is a signal that lies.
    void loadResult.then((status) => {
      if (status !== 'loaded' || generation !== loadGeneration) return
      // The memoized promise resolved 'degraded' so first paint could
      // proceed. The face is present now, so a caller arriving after this
      // point must not still be told it is missing — the tick alone does
      // not reach them, since it fires before they subscribe.
      fontLoadPromise = Promise.resolve<ViewerFontStatus>('loaded')
      notifyReady()
    })
    return 'degraded'
  }
  return settled
}

/**
 * Registers and loads the vendored viewer font, bounded by
 * VIEWER_FONT_LOAD_TIMEOUT_MS. Never rejects — every failure mode (missing
 * API, fetch failure, rejected load, timeout) resolves 'degraded' instead,
 * so a caller can always proceed to render.
 */
export function ensureViewerFontLoaded(): Promise<ViewerFontStatus> {
  if (fontLoadPromise === undefined) {
    loadGeneration += 1
    fontLoadPromise = loadViewerFont(loadGeneration)
  }
  return fontLoadPromise
}

/**
 * Notifies on every readiness tick after the initial ensureViewerFontLoaded()
 * settle — today that is at most one additional tick (a late load finishing
 * after a timeout-degraded settle). Intended for a component that mounted
 * before the font was ready and needs to re-measure once it is.
 */
export function subscribeViewerFontReady(callback: () => void): () => void {
  readySubscribers.add(callback)
  return () => {
    readySubscribers.delete(callback)
  }
}

/** Test-only: clears the memoized promise/subscribers between test cases. */
export function resetViewerFontLoadingForTests(): void {
  fontLoadPromise = undefined
  registeredByBytes.clear()
  loadedByBytes.clear()
  // Orphans any still-pending load from a previous case, so its late result
  // cannot write into the next one.
  loadGeneration += 1
  readySubscribers.clear()
}
