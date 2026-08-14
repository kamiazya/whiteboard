/**
 * The SSE shared worker, loaded the way the app loads it, in a real browser.
 *
 * Everything else covering this worker runs under `@vitest/web-worker` in
 * jsdom — a polyfill that builds a fresh worker context per construction, so
 * it can exercise the message protocol but never the browser's own
 * SharedWorker: not the module load, not `type: 'module'` support, not the
 * same-origin/CSP path. That left the app's ONLY SharedWorker with no evidence
 * it loads at all outside a polyfill, which is a poor foundation for anything
 * that would put more state behind it.
 *
 * Verified while writing this: `type: 'module'` shared workers are supported
 * in Chromium, WebKit and Firefox (checked with static module files in all
 * three via Playwright), so a failure here means this app's chunk, not the
 * browser.
 *
 * Cross-tab SHARING is still not asserted, and deliberately: the worker
 * exposes no observable that distinguishes "one worker, two ports" from "two
 * workers" without adding a test-only seam to production — which is the exact
 * trade this file's jsdom sibling already refuses to make.
 */
import { expect, it } from 'vitest'
import { sseWorkerEventSchema } from './sse-shared-worker-protocol.js'

it('loads as a module shared worker and answers a subscribe', async () => {
  const outcome = await new Promise<
    { kind: 'replied'; data: unknown } | { kind: 'construct-threw' | 'error-event' | 'silent' }
  >((resolve) => {
    let worker: SharedWorker
    try {
      worker = new SharedWorker(new URL('./sse-shared-worker.js', import.meta.url), {
        type: 'module',
        name: 'whiteboard-sse-browser-test',
      })
    } catch {
      resolve({ kind: 'construct-threw' })
      return
    }
    // A module worker that fails to LOAD does not throw at construction — it
    // fires this instead, which is why the app's try/catch cannot see it.
    worker.onerror = () => resolve({ kind: 'error-event' })
    worker.port.onmessage = (e: MessageEvent) => resolve({ kind: 'replied', data: e.data })
    worker.port.start()
    // Pointed at a port nothing listens on: the stream fails to open and the
    // worker reports it, which is a real answer from a running worker and
    // needs no server to stand up.
    worker.port.postMessage({ type: 'init', baseUrl: 'http://127.0.0.1:1', token: 't' })
    worker.port.postMessage({ type: 'subscribe', doc: 'w/browser-probe' })
    setTimeout(() => resolve({ kind: 'silent' }), 8000)
  })

  expect(outcome.kind).toBe('replied')
  if (outcome.kind !== 'replied') return
  // Parsed through the production schema: a reply that does not satisfy it is
  // a protocol drift, not a passing test.
  const parsed = sseWorkerEventSchema.safeParse(outcome.data)
  expect(parsed.success).toBe(true)
  if (!parsed.success) return
  expect(parsed.data.type).toBe('status')
}, 30_000)
