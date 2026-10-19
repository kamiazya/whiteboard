/**
 * What an auth middleware records about a request — its grant, its caller's
 * namespace — is still read by a handler behind `hono/body-limit`. That
 * middleware swaps `c.req.raw` for a new `Request` when the body states no
 * length, so a record keyed on the raw request would answer nobody after it.
 */
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { expect, it } from 'vitest'
import {
  callerNamespaceOf,
  callerNamespaceOfRequest,
  rememberCallerNamespace,
} from '../workspace-handle.js'
import type { ResolvedGrant } from './credential-resolver.js'
import { callerGrant, rememberGrant } from './membership-gate.js'

const GRANT: ResolvedGrant = { kind: 'daemon-token', scopes: [] }

function app() {
  const a = new Hono()
  a.use('*', async (c, next) => {
    rememberGrant(c, GRANT)
    rememberCallerNamespace(c, 'ada')
    await next()
  })
  a.use('*', bodyLimit({ maxSize: 1024 }))
  a.post('/read', async (c) => {
    await c.req.text()
    return c.json({
      grant: callerGrant(c) === GRANT,
      namespace: callerNamespaceOf(c),
      seam: callerNamespaceOfRequest(c.req),
    })
  })
  return a
}

/** A body with no Content-Length: the shape bodyLimit re-wraps. */
function chunked(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"a":1}'))
      controller.close()
    },
  })
}

it('reads the grant and namespace recorded before bodyLimit swapped the request', async () => {
  const res = await app().request('/read', {
    method: 'POST',
    body: chunked(),
    duplex: 'half',
  } as RequestInit)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ grant: true, namespace: 'ada', seam: 'ada' })
})
