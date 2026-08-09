/**
 * Loads the app's real stylesheet into every browser test.
 *
 * Without it, Tailwind utility classes silently do nothing: a `className` of
 * `absolute bottom-3 z-10` computes to `position: static`, so chrome that the
 * app pins to an edge instead lands in ordinary document flow. Elements
 * positioned by INLINE style — the canvas scene's nodes — are unaffected, so
 * an unstyled dock and a correctly-positioned scene can physically collide
 * and a button becomes unclickable. Playwright reports that as a click that
 * never lands rather than a failed assertion, which reads like a hang and
 * points nowhere near the cause.
 *
 * The running app always loads this stylesheet, so a test that renders
 * without it is testing a layout no user ever sees. Loading it here removes
 * the per-file decision entirely.
 */
import '../index.css'
