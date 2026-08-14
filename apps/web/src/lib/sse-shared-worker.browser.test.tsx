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
 * Cross-port fan-out IS asserted here, and can only be asserted here: the
 * jsdom polyfill builds a fresh worker context per construction, so two ports
 * there are two workers. The authority replica gave the worker its first
 * observable that separates the two — a push through one port reaching
 * another — so the gap that sibling documents closes at this layer.
 */
import { LoroDoc } from 'loro-crdt'
import { expect, it, vi } from 'vitest'
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

const b64 = (bytes: Uint8Array) => {
  let out = ''
  for (const byte of bytes) out += String.fromCharCode(byte)
  return btoa(out)
}
const decode = (encoded: string) => Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))

const openPort = (name: string) => {
  const worker = new SharedWorker(new URL('./sse-shared-worker.js', import.meta.url), {
    type: 'module',
    name,
  })
  worker.port.start()
  return worker.port
}

it('carries one port push to another port of the same worker', async () => {
  // Two constructions, one worker — the property the polyfill cannot express,
  // and the whole basis for a replica that several tabs share.
  const NAME = 'whiteboard-sse-fanout-test'
  const a = openPort(NAME)
  const b = openPort(NAME)
  const doc = `w/fanout-${Date.now()}`

  for (const port of [a, b]) {
    port.postMessage({ type: 'init', baseUrl: 'http://127.0.0.1:1', token: 't' })
    port.postMessage({ type: 'subscribe', doc })
  }

  const echoedToSender = vi.fn()
  a.addEventListener('message', (e: MessageEvent) => {
    if ((e.data as { type?: string }).type === 'authority-update') echoedToSender()
  })
  const arrived = new Promise<string>((resolve, reject) => {
    b.addEventListener('message', (e: MessageEvent) => {
      const data = e.data as { type?: string; update?: string }
      if (data.type === 'authority-update' && data.update !== undefined) resolve(data.update)
    })
    setTimeout(() => reject(new Error('no authority-update reached the second port')), 10_000)
  })

  const tab = new LoroDoc()
  tab.getMap('m').set('k', 'from-port-a')
  tab.commit()
  a.postMessage({ type: 'push', doc, update: b64(tab.export({ mode: 'update' })) })

  const forked = new LoroDoc()
  forked.import(decode(await arrived))
  expect(forked.getMap('m').get('k')).toBe('from-port-a')
  // Echoing to the sender would make every edit a round trip through the tab
  // that made it, which is the cost the fork model exists to avoid.
  expect(echoedToSender).not.toHaveBeenCalled()
}, 30_000)

it('hands a later tab a snapshot that already contains an earlier push', async () => {
  // The round trip a replica exists to remove: without it this snapshot would
  // be empty until the daemon echoed the work back.
  const NAME = 'whiteboard-sse-snapshot-test'
  const port = openPort(NAME)
  const doc = `w/snapshot-${Date.now()}`
  port.postMessage({ type: 'init', baseUrl: 'http://127.0.0.1:1', token: 't' })
  port.postMessage({ type: 'subscribe', doc })

  const tab = new LoroDoc()
  tab.getMap('m').set('k', 'already-there')
  tab.commit()
  port.postMessage({ type: 'push', doc, update: b64(tab.export({ mode: 'update' })) })

  const snapshot = await new Promise<string>((resolve, reject) => {
    port.addEventListener('message', (e: MessageEvent) => {
      const data = e.data as { type?: string; snapshot?: string }
      if (data.type === 'snapshot' && data.snapshot !== undefined) resolve(data.snapshot)
    })
    // Queued behind the push, which is the ordering the worker serialises its
    // replica work to guarantee — a snapshot answered from before the push
    // would be an authority that contradicts what it was just told.
    port.postMessage({ type: 'snapshot-request', doc })
    setTimeout(() => reject(new Error('no snapshot came back')), 10_000)
  })

  const forked = new LoroDoc()
  forked.import(decode(snapshot))
  expect(forked.getMap('m').get('k')).toBe('already-there')
}, 30_000)
