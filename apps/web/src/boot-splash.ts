/**
 * Deliberate splash-screen pacing for the index.html boot splash: the app
 * gets ready in the background (font load, module graph), but the splash
 * stays up until its draw animation has completed plus a beat, then fades
 * out before React's first commit replaces it. Without the hold, a fast
 * load dismisses the splash mid-stroke — it reads as a flicker, not a
 * splash. Timings mirror the wb-boot-draw keyframes in index.html.
 */

// The signature stroke finishes drawing at 1.2s (wb-draw in
// public/boot-splash.svg); holding to 1.5s shows the completed stroke plus
// a beat. A longer wait rolls on into the SVG's sketch-then-tidy story,
// which always lands back on the breathing logo.
export const SPLASH_MIN_VISIBLE_MS = 1500
export const SPLASH_FADE_MS = 200

/** How much longer the splash must stay up, measured from first paint. */
export function splashHoldMs(elapsedMs: number, reducedMotion: boolean): number {
  if (reducedMotion) return 0
  return Math.max(0, SPLASH_MIN_VISIBLE_MS - elapsedMs)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Elapsed time since the splash first PAINTED, not since the navigation
 * time origin: on a slow HTML fetch the first paint lags the origin, and
 * an origin-based clock would count time the user never saw the splash,
 * cutting the hold short. First paint precedes module execution, so the
 * paint entry is normally recorded by the time this runs; when it is not
 * (jsdom, very old browsers), fall back to the time origin.
 */
export function elapsedSinceFirstPaint(): number {
  const paints =
    typeof performance.getEntriesByType === 'function' ? performance.getEntriesByType('paint') : []
  const fcp = paints.find((entry) => entry.name === 'first-contentful-paint')
  return Math.max(0, performance.now() - (fcp?.startTime ?? 0))
}

/**
 * Hold the splash out to its minimum visible time, then fade it out.
 * Resolves once the splash is invisible and safe to replace. Reduced
 * motion skips both the artificial hold and the fade — those users get
 * the app as soon as it is ready.
 */
export async function dismissBootSplash({
  doc = document,
  elapsedMs = elapsedSinceFirstPaint(),
  reducedMotion = typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches,
}: {
  doc?: Document
  elapsedMs?: number
  reducedMotion?: boolean
} = {}): Promise<void> {
  const hold = splashHoldMs(elapsedMs, reducedMotion)
  if (hold > 0) await sleep(hold)
  const splash = doc.querySelector('.wb-boot')
  if (!(splash instanceof HTMLElement) || reducedMotion) return
  splash.style.transition = `opacity ${SPLASH_FADE_MS}ms ease-out`
  splash.style.opacity = '0'
  await sleep(SPLASH_FADE_MS)
}
