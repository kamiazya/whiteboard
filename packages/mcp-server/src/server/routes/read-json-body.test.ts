// @vitest-environment node
import { apiErrorBodySchema, apiErrorReason } from '@kamiazya/whiteboard-server-core'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { readJsonBody } from './read-json-body.js'

const schema = z.object({ name: z.string().min(1) }).strict()
const optionalSchema = z.object({ label: z.string().optional() }).strict()

const NOT_JSON_REASON = 'the request body is not valid JSON'

function appFor(voice: 'problem' | 'code', optional: boolean) {
  const app = new Hono()
  app.post('/', async (c) => {
    const read = await readJsonBody(c, optional ? optionalSchema : schema, {
      voice,
      optional,
      refuseShape: (error) =>
        voice === 'problem'
          ? { title: `shape: ${error.issues[0]?.message}` }
          : { error: 'invalid_body', message: `shape: ${error.issues[0]?.message}` },
    })
    return 'refusal' in read ? read.refusal : c.json(read.data)
  })
  return app
}

async function post(app: Hono, body: string | undefined) {
  const res = await app.request('/', { method: 'POST', body })
  return { status: res.status, json: (await res.json()) as unknown }
}

// Each voice answers a body that is not JSON in exactly one way, whatever
// the way it is not JSON: an unreadable body is one mistake, not four.
const NOT_JSON_BODIES: readonly [string, string][] = [
  ['truncated object', '{"name":'],
  ['bare word', 'nope'],
  ['trailing comma', '{"name":"a",}'],
  ['whitespace only', '   '],
]

describe('readJsonBody: the Problem Details voice', () => {
  it.each(NOT_JSON_BODIES)('answers one title for %s', async (_label, body) => {
    expect(await post(appFor('problem', false), body)).toEqual({
      status: 400,
      json: { title: NOT_JSON_REASON },
    })
  })

  it('answers an absent body as not JSON when the body is required', async () => {
    expect(await post(appFor('problem', false), undefined)).toEqual({
      status: 400,
      json: { title: NOT_JSON_REASON },
    })
  })

  it('answers the route shape refusal for JSON of the wrong shape', async () => {
    const { status, json } = await post(appFor('problem', false), '{"name":""}')
    expect(status).toBe(400)
    expect(json).toEqual({ title: expect.stringContaining('shape: ') })
  })

  it('answers the parsed data when it fits', async () => {
    expect(await post(appFor('problem', false), '{"name":"a"}')).toEqual({
      status: 200,
      json: { name: 'a' },
    })
  })

  it('answers a body every client reader accepts', async () => {
    const { json } = await post(appFor('problem', false), 'nope')
    expect(apiErrorBodySchema.safeParse(json).success).toBe(true)
    expect(apiErrorReason(json)).toBe(NOT_JSON_REASON)
  })
})

describe('readJsonBody: the { error, message } voice', () => {
  it.each(NOT_JSON_BODIES)('answers one code and message for %s', async (_label, body) => {
    expect(await post(appFor('code', false), body)).toEqual({
      status: 400,
      json: { error: 'invalid_body', message: NOT_JSON_REASON },
    })
  })

  it('answers an absent body as not JSON when the body is required', async () => {
    expect(await post(appFor('code', false), undefined)).toEqual({
      status: 400,
      json: { error: 'invalid_body', message: NOT_JSON_REASON },
    })
  })

  it('answers the route shape refusal for JSON of the wrong shape', async () => {
    const { status, json } = await post(appFor('code', false), '{"zzz":1}')
    expect(status).toBe(400)
    expect(json).toEqual({ error: 'invalid_body', message: expect.stringContaining('shape: ') })
  })

  it('answers a body every client reader accepts', async () => {
    const { json } = await post(appFor('code', false), 'nope')
    expect(apiErrorBodySchema.safeParse(json).success).toBe(true)
    expect(apiErrorReason(json)).toBe(NOT_JSON_REASON)
  })
})

describe('readJsonBody: an optional body', () => {
  it.each([
    'problem',
    'code',
  ] as const)('reads an empty body as the schema defaults in the %s voice', async (voice) => {
    expect(await post(appFor(voice, true), '')).toEqual({ status: 200, json: {} })
  })

  it.each([
    'problem',
    'code',
  ] as const)('still refuses a PRESENT body that is not JSON in the %s voice', async (voice) => {
    const { status, json } = await post(appFor(voice, true), '{nope')
    expect(status).toBe(400)
    expect(apiErrorReason(json)).toBe(NOT_JSON_REASON)
  })

  // Only a body with nothing in it is absent. Whitespace was sent, and a
  // sender that sends something meant to send JSON.
  it('refuses a whitespace-only body as present and not JSON', async () => {
    expect(await post(appFor('code', true), ' \n')).toEqual({
      status: 400,
      json: { error: 'invalid_body', message: NOT_JSON_REASON },
    })
  })

  it('still refuses a present body the schema rejects', async () => {
    const { status } = await post(appFor('code', true), '{"zzz":1}')
    expect(status).toBe(400)
  })

  it('reads JSON null as a body of the wrong shape, not as absent', async () => {
    const { status, json } = await post(appFor('code', false), 'null')
    expect(status).toBe(400)
    expect(json).toEqual({ error: 'invalid_body', message: expect.stringContaining('shape: ') })
  })
})

describe('readJsonBody: the size ceiling', () => {
  const MIB = 1024 * 1024
  const lenient = z.object({ pad: z.string() }).strict()

  function appCapped(maxBytes?: number) {
    const app = new Hono()
    app.post('/', async (c) => {
      const read = await readJsonBody(c, lenient, {
        voice: 'code',
        refuseShape: () => ({ error: 'invalid_body', message: 'shape' }),
        ...(maxBytes === undefined ? {} : { maxBytes }),
      })
      return 'refusal' in read ? read.refusal : c.json({ read: read.data.pad.length })
    })
    return app
  }

  const bodyOf = (padding: number) => JSON.stringify({ pad: 'x'.repeat(padding) })

  it('refuses a body past a megabyte by default, in the daemon refusal voice', async () => {
    const res = await appCapped().request('/', { method: 'POST', body: bodyOf(MIB) })

    expect(res.status).toBe(413)
    expect(apiErrorBodySchema.parse(await res.json())).toEqual({
      error: 'payload_too_large',
      message: `Request body exceeds ${MIB} bytes limit.`,
    })
  })

  it('reads a body just inside the default', async () => {
    const padding = MIB - bodyOf(0).length

    const res = await appCapped().request('/', { method: 'POST', body: bodyOf(padding) })

    expect(await res.json()).toEqual({ read: padding })
  })

  it('refuses on the declared length without reading the body', async () => {
    const res = await appCapped(10).request('/', {
      method: 'POST',
      headers: { 'content-length': '11' },
      body: bodyOf(0),
    })

    expect(res.status).toBe(413)
  })

  it('stops a chunked body that declares no length at the ceiling', async () => {
    let pulled = 0
    const chunk = new TextEncoder().encode('x'.repeat(1024))
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1
        if (pulled > 200) controller.close()
        else controller.enqueue(chunk)
      },
    })

    const res = await appCapped(4096).request('/', {
      method: 'POST',
      body,
      // @ts-expect-error: `duplex` is required by the fetch spec for a stream body and absent from the DOM lib types
      duplex: 'half',
    })

    expect(res.status).toBe(413)
    // The reader gave up past the ceiling instead of draining the whole body.
    expect(pulled).toBeLessThan(20)
  })

  it('takes the ceiling a route names over the default', async () => {
    const res = await appCapped(2 * MIB).request('/', { method: 'POST', body: bodyOf(MIB) })

    expect(res.status).toBe(200)
  })
})
