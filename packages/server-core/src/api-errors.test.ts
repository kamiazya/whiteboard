import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { apiErrorBodySchema, apiErrorReason, issueText } from './api-errors.js'

describe('apiErrorBodySchema', () => {
  it.each([
    [{ title: 'Canvas not found' }],
    [{ error: 'branch_conflict' }],
    [{ error: 'branch_conflict', message: 'A variation named "x" already exists' }],
    // A refusal that names what it concerns (ADR-0051: a sole owner's deletion).
    [{ error: 'sole_owner', message: 'm', workspaceIds: ['w'] }],
  ])('accepts %j', (body) => {
    expect(apiErrorBodySchema.safeParse(body).success).toBe(true)
  })

  it.each([
    // An out-of-contract body must FAIL to parse: the previous
    // title-optional schema accepted every object, which is exactly how a
    // reason spelled differently got silently discarded.
    [{}],
    [{ oops: 1 }],
    [{ title: '' }],
    [{ message: 'reason without a code' }],
    // The EMISSION contract stays closed: an undeclared field a route wrote is
    // a reason put where no reader looks. Reading is the tolerant half.
    [{ error: 'branch_conflict', issues: [] }],
    [null],
    ['plain string'],
  ])('rejects %j', (body) => {
    expect(apiErrorBodySchema.safeParse(body).success).toBe(false)
  })
})

describe('apiErrorReason', () => {
  it('returns the title for the Problem Details arm', () => {
    expect(apiErrorReason({ title: 'Canvas "x" already exists' })).toBe('Canvas "x" already exists')
  })

  it('returns the message for the code+reason arm', () => {
    expect(apiErrorReason({ error: 'branch_conflict', message: 'already exists' })).toBe(
      'already exists',
    )
  })

  it('reads the reason of a body a newer daemon gave a field this bundle has not heard of', () => {
    expect(apiErrorReason({ error: 'rate_limited', message: 'slow down', retryAfter: 3 })).toBe(
      'slow down',
    )
    expect(apiErrorReason({ title: 'Gone', type: 'about:blank', status: 410 })).toBe('Gone')
  })

  it('reads the sentence of a refusal naming the workspaces it concerns', () => {
    expect(
      apiErrorReason({ error: 'sole_owner', message: 'still the only owner', workspaceIds: ['w'] }),
    ).toBe('still the only owner')
  })

  it('returns undefined for a bare code and for out-of-contract bodies', () => {
    expect(apiErrorReason({ error: 'branch_conflict' })).toBeUndefined()
    expect(apiErrorReason({ oops: 1 })).toBeUndefined()
    expect(apiErrorReason(undefined)).toBeUndefined()
  })
})

describe('issueText', () => {
  it('prefixes the path of a nested issue and leaves a top-level one bare', () => {
    const schema = z.object({ operator: z.object({ kind: z.string() }).strict() }).strict()
    const nested = schema.safeParse({ operator: { kind: 'human', zzz: 1 } })
    const top = schema.safeParse({ operator: { kind: 'human' }, zzz: 1 })
    if (nested.success || top.success) throw new Error('expected refusals')
    expect(issueText(nested.error.issues[0])).toBe('operator: Unrecognized key: "zzz"')
    expect(issueText(top.error.issues[0])).toBe('Unrecognized key: "zzz"')
  })
})
