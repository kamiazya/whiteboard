/**
 * The 413 an oversized request answers, from the one place that writes it.
 * Each route's suite pins its own noun and limit; this pins the contract they
 * share, so a change to the code or the wording names the helper's test first.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { apiErrorBodySchema } from '@kamiazya/whiteboard-server-core'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { stripComments } from '../../shared/test-utils/strip-comments.js'
import {
  CONTENT_BODY_LIMIT_BYTES,
  EXPORT_OPTIONS_BODY_LIMIT_BYTES,
  limitBody,
} from './body-limit.js'

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

describe('limitBody and the request a later handler recognises', () => {
  // Server mode memoises the grant that authenticated a request against the
  // Request object itself (`membership-gate.ts`), so a ceiling that hands the
  // handler a rebuilt Request makes the caller anonymous to the handler.
  it.each([
    ['a body with no declared length', undefined],
    ['a body with a declared length', 'okay'.length],
  ])('passes %s on in the very Request it was given', async (_name, declared) => {
    const app = new Hono()
    let before: Request | undefined
    app.use('*', async (c, next) => {
      before = c.req.raw
      await next()
    })
    app.post('/x', limitBody(100, 'Upload'), async (c) =>
      c.json({ same: c.req.raw === before, text: await c.req.text() }),
    )
    const headers = declared === undefined ? {} : { 'content-length': String(declared) }

    const res = await app.request('/x', { method: 'POST', body: 'okay', headers })

    expect(await res.json()).toEqual({ same: true, text: 'okay' })
  })
})

describe('EXPORT_OPTIONS_BODY_LIMIT_BYTES', () => {
  it('bounds an options object, not canvas content', () => {
    expect(EXPORT_OPTIONS_BODY_LIMIT_BYTES).toBe(1024 * 1024)
  })
})

describe('CONTENT_BODY_LIMIT_BYTES', () => {
  it('is 16 MiB, the ceiling payload-too-large.test.ts spells out for each content route', () => {
    expect(CONTENT_BODY_LIMIT_BYTES).toBe(16 * 1024 * 1024)
  })

  // Declared in three places before, each saying to match the others; a fourth
  // route copying the number is how they would drift again.
  it('is the only place a route spells that number', async () => {
    const entries = await readdir(import.meta.dirname, { recursive: true })
    const sources = entries.filter((e) => e.endsWith('.ts') && !e.endsWith('.test.ts'))
    expect(sources.length).toBeGreaterThan(20)
    const spelling = /16\s*\*\s*1024\s*\*\s*1024|\b16_?777_?216\b/
    const offenders: string[] = []
    for (const entry of sources) {
      if (entry === 'body-limit.ts') continue
      const code = stripComments(await readFile(join(import.meta.dirname, entry), 'utf8'))
      if (spelling.test(code)) offenders.push(entry)
    }
    expect(offenders).toEqual([])
  })
})
