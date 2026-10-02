/**
 * The 413 an oversized request answers, from the one place that writes it.
 * Each route's suite pins its own noun and limit; this pins the contract they
 * share, so a change to the code or the wording names the helper's test first.
 */
import { apiErrorBodySchema } from '@kamiazya/whiteboard-server-core'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { EXPORT_OPTIONS_BODY_LIMIT_BYTES, limitBody } from './body-limit.js'

function appLimitedTo(maxSize: number, noun: string) {
  const app = new Hono()
  app.post('/x', limitBody(maxSize, noun), (c) => c.text('stored'))
  return app
}

describe('limitBody', () => {
  it('answers 413 payload_too_large naming the noun and the limit', async () => {
    const res = await appLimitedTo(4, 'Upload').request('/x', { method: 'POST', body: 'too big' })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({
      error: 'payload_too_large',
      message: 'Upload exceeds 4 bytes limit.',
    })
  })

  it('answers a body inside the contract clients read refusals through', async () => {
    const res = await appLimitedTo(4, 'Update').request('/x', { method: 'POST', body: 'too big' })
    expect(apiErrorBodySchema.safeParse(await res.json()).success).toBe(true)
  })

  it('lets a body at the limit through', async () => {
    const res = await appLimitedTo(4, 'Upload').request('/x', { method: 'POST', body: 'okay' })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('stored')
  })
})

describe('EXPORT_OPTIONS_BODY_LIMIT_BYTES', () => {
  it('bounds an options object, not canvas content', () => {
    expect(EXPORT_OPTIONS_BODY_LIMIT_BYTES).toBe(1024 * 1024)
  })
})
