/**
 * The cross-origin transfer contract, at the two points where getting it
 * wrong is silent.
 *
 * Both are about a check that LOOKS like it works. A `z.instanceof`
 * validator passes every test that builds its bytes in-realm and refuses
 * every real message, because a structured clone arrives from the sending
 * realm. And a sender origin parsed loosely builds a comparison against
 * `event.origin` that can never match, which reads as "the other side never
 * replied" rather than as a bad URL.
 */
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  CROSS_ORIGIN_TRANSFER_PROTOCOL,
  parseTransferWindowUrl,
  transferRequestSchema,
  transferResponseSchema,
  transferWindowUrl,
} from './cross-origin-transfer-protocol.js'
import { LEFT_BEHIND_MAX_CHARS, LEFT_BEHIND_MAX_ENTRIES } from './user-settings-store.js'

const NONCE = 'n'.repeat(32)

const offer = (over: Record<string, unknown> = {}) => ({
  type: 'transfer-offer',
  protocol: CROSS_ORIGIN_TRANSFER_PROTOCOL,
  nonce: NONCE,
  snapshot: Uint8Array.from([1, 2, 3]),
  documentCount: 2,
  sourceWorkspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  ...over,
})

describe('the transfer offer', () => {
  it('accepts a snapshot that arrived from ANOTHER realm, where instanceof answers false', () => {
    // A REAL second realm, not a hand-built stand-in. The first attempt at
    // this test built one with `Object.create(Uint8Array.prototype)`, which
    // is `instanceof Uint8Array` — so swapping the tag check for
    // `instanceof` left it green and the test discriminated nothing.
    const frame = document.createElement('iframe')
    document.body.append(frame)
    try {
      const other = frame.contentWindow as unknown as { Uint8Array: typeof Uint8Array }
      const foreign = new other.Uint8Array([1, 2, 3])
      // The premise, asserted rather than assumed: this value really is what
      // a structured clone hands over — right tag, wrong constructor.
      expect(other.Uint8Array).not.toBe(Uint8Array)
      expect(foreign).not.toBeInstanceOf(Uint8Array)
      expect(Object.prototype.toString.call(foreign)).toBe('[object Uint8Array]')

      const parsed = transferRequestSchema.safeParse(offer({ snapshot: foreign }))
      expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true)
    } finally {
      frame.remove()
    }
  })

  it('refuses a snapshot that is merely array-like, so a plain object cannot pass for bytes', () => {
    expect(transferRequestSchema.safeParse(offer({ snapshot: [1, 2, 3] })).success).toBe(false)
    expect(transferRequestSchema.safeParse(offer({ snapshot: { length: 3 } })).success).toBe(false)
  })

  it('refuses a nonce too short to distinguish one attempt from another', () => {
    expect(transferRequestSchema.safeParse(offer({ nonce: 'abc' })).success).toBe(false)
  })
})

describe('the bounds of the transfer messages', () => {
  const ready = (over: Record<string, unknown> = {}) => ({
    type: 'transfer-ready',
    protocol: CROSS_ORIGIN_TRANSFER_PROTOCOL,
    nonce: NONCE,
    ...over,
  })
  const refusal = (over: Record<string, unknown> = {}) => ({
    type: 'transfer-result',
    nonce: NONCE,
    ok: false,
    reason: 'declined',
    ...over,
  })

  it('accepts a nonce of 16 to 128 characters on every message and refuses one outside that', () => {
    const messages = [
      [transferRequestSchema, ready],
      [transferRequestSchema, offer],
      [transferResponseSchema, refusal],
    ] as const
    for (const [schema, build] of messages) {
      for (const length of [16, 128]) {
        const nonce = 'n'.repeat(length)
        expect(schema.safeParse(build({ nonce })).success, `${build({}).type} ${length}`).toBe(true)
      }
      for (const length of [0, 15, 129]) {
        const nonce = 'n'.repeat(length)
        expect(schema.safeParse(build({ nonce })).success, `${build({}).type} ${length}`).toBe(
          false,
        )
      }
    }
  })

  it('refuses a protocol that is not a positive integer', () => {
    for (const protocol of [0, -1, 1.5, '1']) {
      expect(transferRequestSchema.safeParse(ready({ protocol })).success, String(protocol)).toBe(
        false,
      )
      expect(transferRequestSchema.safeParse(offer({ protocol })).success, String(protocol)).toBe(
        false,
      )
    }
  })

  it('accepts a claim of zero documents and refuses a negative or fractional one', () => {
    expect(transferRequestSchema.safeParse(offer({ documentCount: 0 })).success).toBe(true)
    expect(transferRequestSchema.safeParse(offer({ documentCount: -1 })).success).toBe(false)
    expect(transferRequestSchema.safeParse(offer({ documentCount: 1.5 })).success).toBe(false)
  })

  it('refuses an offer that names no source workspace', () => {
    expect(transferRequestSchema.safeParse(offer({ sourceWorkspaceId: '' })).success).toBe(false)
  })

  it('refuses a success that names no workspace in the receiving keeper', () => {
    const success = {
      type: 'transfer-result',
      nonce: NONCE,
      ok: true,
      workspaceId: 'ws-there',
      promotedDocumentIds: [],
      shadowedPaths: [],
    }
    expect(transferResponseSchema.safeParse(success).success).toBe(true)
    expect(transferResponseSchema.safeParse({ ...success, workspaceId: '' }).success).toBe(false)
  })
})

describe('the transfer result', () => {
  it('carries what the receiver merged, and a refusal carries a sentence', () => {
    const ok = transferResponseSchema.safeParse({
      type: 'transfer-result',
      nonce: NONCE,
      ok: true,
      workspaceId: 'ws-a',
      promotedDocumentIds: ['01ARZ3NDEKTSV4RRFFQ69G5FAV'],
      shadowedPaths: ['contested'],
    })
    expect(ok.success).toBe(true)

    const refused = transferResponseSchema.safeParse({
      type: 'transfer-result',
      nonce: NONCE,
      ok: false,
      reason: 'This workspace is over its capacity.',
    })
    expect(refused.success).toBe(true)
  })

  it('marks a decline as one, so the sender can tell it from a keeper refusing', () => {
    const decline = {
      type: 'transfer-result',
      nonce: NONCE,
      ok: false,
      declined: true,
      reason: 'The transfer was declined at the destination, so nothing was merged there.',
    }
    const parsed = transferResponseSchema.safeParse(decline)
    expect(parsed.success).toBe(true)
    expect(parsed.data).toEqual(decline)
    expect(transferResponseSchema.safeParse({ ...decline, declined: false }).success).toBe(false)
  })

  it('refuses a refusal with no reason, since the sender shows the reason as-is', () => {
    const parsed = transferResponseSchema.safeParse({
      type: 'transfer-result',
      nonce: NONCE,
      ok: false,
      reason: '',
    })
    expect(parsed.success).toBe(false)
  })

  describe('what it left behind, bounded since the sender shows it as-is', () => {
    const withLeftBehind = (leftBehind: string[]) =>
      transferResponseSchema.safeParse({
        type: 'transfer-result',
        nonce: NONCE,
        ok: true,
        workspaceId: 'ws-a',
        promotedDocumentIds: [],
        shadowedPaths: [],
        leftBehind,
      }).success

    it('accepts as many sentences as the bound, and refuses one more', () => {
      const atBound = Array.from({ length: LEFT_BEHIND_MAX_ENTRIES }, () => 'a version')
      expect(withLeftBehind(atBound)).toBe(true)
      expect(withLeftBehind([...atBound, 'a version'])).toBe(false)
    })

    it('accepts a sentence as long as the bound, and refuses a longer one', () => {
      expect(withLeftBehind(['x'.repeat(LEFT_BEHIND_MAX_CHARS)])).toBe(true)
      expect(withLeftBehind(['x'.repeat(LEFT_BEHIND_MAX_CHARS + 1)])).toBe(false)
    })
  })
})

/**
 * The REQUIRED keys of every message, as each released protocol version
 * shipped them. A reader built against one of these refuses a message
 * missing a key it requires, and a reader built now refuses one missing a
 * key it requires — so adding or removing a required key breaks the other
 * side's older build, and must come with a new protocol number and a new
 * row here. An optional key changes neither and needs neither.
 */
const RELEASED_REQUIRED_KEYS: Record<number, Record<string, readonly string[]>> = {
  1: {
    'transfer-ready': ['type', 'protocol', 'nonce'],
    'transfer-offer': [
      'type',
      'protocol',
      'nonce',
      'snapshot',
      'documentCount',
      'sourceWorkspaceId',
    ],
    'transfer-result ok': [
      'type',
      'nonce',
      'ok',
      'workspaceId',
      'promotedDocumentIds',
      'shadowedPaths',
      'attested',
    ],
    'transfer-result refused': ['type', 'nonce', 'ok', 'reason'],
  },
  2: {
    'transfer-ready': ['type', 'protocol', 'nonce'],
    'transfer-offer': [
      'type',
      'protocol',
      'nonce',
      'snapshot',
      'documentCount',
      'sourceWorkspaceId',
    ],
    'transfer-result ok': [
      'type',
      'nonce',
      'ok',
      'workspaceId',
      'promotedDocumentIds',
      'shadowedPaths',
    ],
    'transfer-result refused': ['type', 'nonce', 'ok', 'reason'],
  },
}

/** Each arm of the live schemas, under the name its ledger row uses. */
function liveRequiredKeys(): Record<string, readonly string[]> {
  const required = (shape: Record<string, z.ZodType>) =>
    Object.entries(shape)
      .filter(([, schema]) => !schema.safeParse(undefined).success)
      .map(([key]) => key)
  const [ready, offerArm] = transferRequestSchema.options
  const [ok, refused] = transferResponseSchema.options
  return {
    'transfer-ready': required(ready.shape),
    'transfer-offer': required(offerArm.shape),
    'transfer-result ok': required(ok.shape),
    'transfer-result refused': required(refused.shape),
  }
}

describe('the protocol version', () => {
  it('has a released row whose required keys are exactly those of the live messages', () => {
    const released = RELEASED_REQUIRED_KEYS[CROSS_ORIGIN_TRANSFER_PROTOCOL]
    expect(released, `no released row for protocol ${CROSS_ORIGIN_TRANSFER_PROTOCOL}`).toBeDefined()
    const live = liveRequiredKeys()
    // The probe reaches every arm, so a lost arm cannot read as agreement.
    expect(Object.keys(live)).toHaveLength(4)
    for (const [message, keys] of Object.entries(live)) {
      expect([...keys].sort(), message).toEqual([...(released?.[message] ?? [])].sort())
    }
  })

  it('differs from every earlier release in some required key, or it would not be a new number', () => {
    const current = JSON.stringify(RELEASED_REQUIRED_KEYS[CROSS_ORIGIN_TRANSFER_PROTOCOL])
    for (const [version, row] of Object.entries(RELEASED_REQUIRED_KEYS)) {
      if (Number(version) === CROSS_ORIGIN_TRANSFER_PROTOCOL) continue
      expect(JSON.stringify(row), `protocol ${version}`).not.toBe(current)
    }
  })
})

describe('the window URL carries the sender origin in its fragment', () => {
  it('round-trips, and puts nothing in the part the keeper would log', () => {
    const url = transferWindowUrl('https://keeper.example/', {
      senderOrigin: 'https://app.example',
      nonce: NONCE,
    })
    // A fragment is never sent to the server, so the keeper's access log does
    // not accumulate which app sent people to it.
    const [beforeHash] = url.split('#')
    expect(beforeHash).toBe('https://keeper.example/receive-transfer')
    // Several trailing slashes, which is what distinguishes the trim loop
    // from a single slice — and a keeper base URL a person typed can have
    // them.
    expect(
      transferWindowUrl('https://keeper.example///', {
        senderOrigin: 'https://app.example',
        nonce: NONCE,
      }).split('#')[0],
    ).toBe('https://keeper.example/receive-transfer')
    expect(parseTransferWindowUrl(`#${url.split('#')[1]}`)).toEqual({
      senderOrigin: 'https://app.example',
      nonce: NONCE,
    })
  })

  it('refuses a sender that is a URL rather than an ORIGIN', () => {
    // `event.origin` is only ever scheme://host[:port], so accepting any of
    // these would build a comparison that cannot succeed — and the symptom
    // is a transfer that silently never completes.
    for (const from of [
      'https://app.example/path',
      'https://app.example?a=1',
      'https://user:pw@app.example',
      'app.example',
      '',
    ]) {
      const hash = `#${new URLSearchParams({ from, nonce: NONCE }).toString()}`
      expect(parseTransferWindowUrl(hash), from).toBeNull()
    }
  })

  it('refuses a missing sender and a nonce longer than the protocol allows', () => {
    expect(parseTransferWindowUrl(`#${new URLSearchParams({ nonce: NONCE })}`)).toBeNull()
    expect(
      parseTransferWindowUrl(
        `#${new URLSearchParams({ from: 'https://app.example', nonce: 'n'.repeat(129) })}`,
      ),
    ).toBeNull()
  })

  it('refuses a missing nonce and a nonce too short, rather than defaulting one', () => {
    expect(
      parseTransferWindowUrl(`#${new URLSearchParams({ from: 'https://app.example' })}`),
    ).toBeNull()
    expect(
      parseTransferWindowUrl(
        `#${new URLSearchParams({ from: 'https://app.example', nonce: 'abc' })}`,
      ),
    ).toBeNull()
  })
})
