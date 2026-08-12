import { getAppLogger } from './app-logger.js'

const log = getAppLogger('celebrate')

// The brand palette: blue spark first (the AI's hand), then the status hues.
const BRAND_COLORS = ['#3b6ecc', '#16a34a', '#d97706', '#e8564f', '#8a63d2']

/**
 * One-shot confetti burst marking a setup step completing. Never loops, and
 * canvas-confetti's own reduced-motion guard suppresses it entirely for users
 * who opted out of motion. Fires from the center of `originEl` when given so
 * the celebration reads as belonging to the step that completed.
 *
 * canvas-confetti stays behind a dynamic import: celebrations are rare and
 * the entry-chunk budget is tight (scripts/smoke-bundle-size.mjs).
 */
export async function celebrate(originEl?: HTMLElement): Promise<void> {
  try {
    const { default: confetti } = await import('canvas-confetti')
    let origin: { x: number; y: number } | undefined
    if (originEl !== undefined) {
      const rect = originEl.getBoundingClientRect()
      origin = {
        x: (rect.left + rect.width / 2) / window.innerWidth,
        y: (rect.top + rect.height / 2) / window.innerHeight,
      }
    }
    await confetti({
      particleCount: 60,
      spread: 70,
      startVelocity: 28,
      colors: BRAND_COLORS,
      disableForReducedMotion: true,
      origin,
    })
  } catch (err) {
    // A celebration must never break the page it celebrates.
    log.warn('confetti burst failed', err)
  }
}
