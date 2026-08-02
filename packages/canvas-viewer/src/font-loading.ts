// Loads the vendored Roboto face (the exact bytes mcp-server's opentype.js
// exporter measures) as a real webfont, so the browser's Canvas 2D
// `measureText` and the Node export pipeline agree on line breaks and
// content sizing. Without this, `document.fonts` never contains the face,
// Canvas 2D silently falls back to a system font, and the editor's on-screen
// layout diverges from what a user exports (see font.ts's doc comment).

// eslint-disable-next-line import/no-unresolved -- Vite's `?url` asset suffix, resolved at build/dev-server time.
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

async function loadViewerFont(generation: number): Promise<ViewerFontStatus> {
  // Totality: an environment with no FontFace constructor or no
  // document.fonts (a non-browser test runner, or a browser lacking the
  // API) degrades instead of throwing — the caller always gets a value.
  if (
    typeof FontFace === 'undefined' ||
    typeof document === 'undefined' ||
    document.fonts === undefined
  ) {
    return 'degraded'
  }

  let face: FontFace
  try {
    face = new FontFace(VIEWER_FONT_FAMILY, `url(${robotoFontUrl})`)
    document.fonts.add(face)
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
  // Orphans any still-pending load from a previous case, so its late result
  // cannot write into the next one.
  loadGeneration += 1
  readySubscribers.clear()
}
