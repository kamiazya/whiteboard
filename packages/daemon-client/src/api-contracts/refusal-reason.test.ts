import { describe, expect, it } from 'vitest'
import { refusalReasonOf } from './refusal-reason.js'

const FALLBACK = 'Request failed (409).'

const json = (body: unknown, status = 409) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

describe('refusalReasonOf', () => {
  it.each([
    {
      name: 'an RFC 9457 problem body answers its title',
      res: () => json({ type: 'about:blank', title: 'Path already exists', status: 409 }),
      reason: 'Path already exists',
    },
    {
      name: 'an error-code body answers its message',
      res: () => json({ error: 'path_conflict', message: 'That path is taken.' }),
      reason: 'That path is taken.',
    },
    {
      name: 'a bare error code states no reason',
      res: () => json({ error: 'path_conflict' }),
      reason: FALLBACK,
    },
    {
      name: 'a hint alone is not a reason',
      res: () => json({ error: 'path_conflict', hint: 'Open it in a browser.' }),
      reason: FALLBACK,
    },
    {
      name: 'a body outside the contract states no reason',
      res: () => json({ message: 'not in the contract' }),
      reason: FALLBACK,
    },
    {
      name: 'a body that is not JSON states no reason',
      res: () => new Response('<html>bad gateway</html>', { status: 409 }),
      reason: FALLBACK,
    },
    {
      name: 'an empty body states no reason',
      res: () => new Response(null, { status: 409 }),
      reason: FALLBACK,
    },
  ])('$name', async ({ res, reason }) => {
    expect((await refusalReasonOf(res(), FALLBACK)).reason).toBe(reason)
  })

  it('hands back the parsed body, so a typed refusal can be read by code', async () => {
    const body = { error: 'not_a_member', message: 'You are not a member.' }
    expect(await refusalReasonOf(json(body, 403), FALLBACK)).toEqual({
      reason: 'You are not a member.',
      body,
    })
  })

  it('hands back undefined for a body that was not JSON', async () => {
    const { body } = await refusalReasonOf(new Response('nope', { status: 502 }), FALLBACK)
    expect(body).toBeUndefined()
  })
})
