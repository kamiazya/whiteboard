// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { DaemonApiError } from './daemon-api-client.js'
import { membershipRefusal, PASSKEY_NEEDED_COPY, withOnePasskeyBind } from './membership-refusal.js'

describe('membershipRefusal', () => {
  it('answers the code for a not_a_member refusal, regardless of the message sentence', () => {
    const err = new DaemonApiError('irrelevant text', 403, {
      error: 'not_a_member',
      message: 'anything else',
    })
    expect(membershipRefusal(err)).toBe('not_a_member')
  })

  it('answers the code for a requires_person_session refusal', () => {
    const err = new DaemonApiError('irrelevant text', 403, {
      error: 'requires_person_session',
      message: 'session is not bound',
    })
    expect(membershipRefusal(err)).toBe('requires_person_session')
  })

  it('answers null for a membership refusal code this slice does not act on, even carrying the classifier sentence', () => {
    const err = new DaemonApiError('irrelevant text', 403, {
      error: 'unknown_workspace',
      message: 'this session is not signed in as a member',
    })
    expect(membershipRefusal(err)).toBeNull()
  })

  it('answers null for a body that fails the strict schema (an extra key)', () => {
    const err = new DaemonApiError('irrelevant text', 403, {
      error: 'not_a_member',
      message: 'm',
      extra: 'nope',
    })
    expect(membershipRefusal(err)).toBeNull()
  })

  it('answers null for a 404 DaemonApiError', () => {
    const err = new DaemonApiError('not found', 404, undefined)
    expect(membershipRefusal(err)).toBeNull()
  })

  it('answers null for a plain Error', () => {
    expect(membershipRefusal(new Error('boom'))).toBeNull()
  })

  // Metamorphic: the classifier reads the CODE only. Matching the message
  // sentence instead is exactly the regression this guards — mutation-check:
  // replacing the schema-parse with a message match fails this for any
  // message other than the one sentence that mutation hardcodes.
  fcTest.prop([fc.string({ minLength: 1 })], withDefaults())(
    'is constant in the message, for a fixed code',
    (message) => {
      const err = new DaemonApiError('irrelevant', 403, { error: 'not_a_member', message })
      expect(membershipRefusal(err)).toBe('not_a_member')
    },
  )
})

describe('withOnePasskeyBind', () => {
  function refusal(code: 'requires_person_session' | 'not_a_member') {
    return new DaemonApiError('refused', 403, { error: code, message: 'm' })
  }

  it('binds once and resolves when the retry succeeds', async () => {
    const bind = vi.fn().mockResolvedValue({ ok: true })
    const load = vi
      .fn()
      .mockRejectedValueOnce(refusal('requires_person_session'))
      .mockResolvedValueOnce('ok')
    const guard = { attempted: false }
    await expect(withOnePasskeyBind(load, bind, guard)).resolves.toBe('ok')
    expect(bind).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('rethrows the second refusal without binding a second time', async () => {
    const bind = vi.fn().mockResolvedValue({ ok: true })
    const second = refusal('requires_person_session')
    const load = vi
      .fn()
      .mockRejectedValueOnce(refusal('requires_person_session'))
      .mockRejectedValueOnce(second)
    const guard = { attempted: false }
    await expect(withOnePasskeyBind(load, bind, guard)).rejects.toBe(second)
    expect(bind).toHaveBeenCalledTimes(1)
  })

  it('rethrows the original refusal when the bind itself fails, without a second bind', async () => {
    const bind = vi.fn().mockResolvedValue({ ok: false })
    const first = refusal('requires_person_session')
    const load = vi.fn().mockRejectedValueOnce(first)
    const guard = { attempted: false }
    await expect(withOnePasskeyBind(load, bind, guard)).rejects.toBe(first)
    expect(bind).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('never binds when the guard already attempted', async () => {
    const bind = vi.fn().mockResolvedValue({ ok: true })
    const err = refusal('requires_person_session')
    const load = vi.fn().mockRejectedValueOnce(err)
    const guard = { attempted: true }
    await expect(withOnePasskeyBind(load, bind, guard)).rejects.toBe(err)
    expect(bind).not.toHaveBeenCalled()
  })

  it('never binds on a non-refusal error', async () => {
    const bind = vi.fn().mockResolvedValue({ ok: true })
    const err = new Error('network down')
    const load = vi.fn().mockRejectedValueOnce(err)
    const guard = { attempted: false }
    await expect(withOnePasskeyBind(load, bind, guard)).rejects.toBe(err)
    expect(bind).not.toHaveBeenCalled()
  })

  it('a second, separate call sharing the same guard never binds again once the first call bound', async () => {
    // The real usage: the controller's resolve effect calls withOnePasskeyBind
    // once per run, sharing one guard across the page's lifetime — a second
    // resolve (e.g. a re-render) must not re-arm the passkey prompt.
    const bind = vi.fn().mockResolvedValue({ ok: true })
    const guard = { attempted: false }
    const firstLoad = vi
      .fn()
      .mockRejectedValueOnce(refusal('requires_person_session'))
      .mockResolvedValueOnce('ok')
    await expect(withOnePasskeyBind(firstLoad, bind, guard)).resolves.toBe('ok')
    expect(bind).toHaveBeenCalledTimes(1)

    const secondErr = refusal('requires_person_session')
    const secondLoad = vi.fn().mockRejectedValueOnce(secondErr)
    await expect(withOnePasskeyBind(secondLoad, bind, guard)).rejects.toBe(secondErr)
    expect(bind).toHaveBeenCalledTimes(1)
  })

  it('never binds on a not_a_member refusal (only requires_person_session triggers a bind)', async () => {
    const bind = vi.fn().mockResolvedValue({ ok: true })
    const err = refusal('not_a_member')
    const load = vi.fn().mockRejectedValueOnce(err)
    const guard = { attempted: false }
    await expect(withOnePasskeyBind(load, bind, guard)).rejects.toBe(err)
    expect(bind).not.toHaveBeenCalled()
  })
})

describe('PASSKEY_NEEDED_COPY', () => {
  it('names a jargon-free body and a retry action', () => {
    expect(PASSKEY_NEEDED_COPY.body.length).toBeGreaterThan(0)
    expect(PASSKEY_NEEDED_COPY.action.length).toBeGreaterThan(0)
  })
})
