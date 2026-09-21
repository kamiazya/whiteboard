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
import {
  CROSS_ORIGIN_TRANSFER_PROTOCOL,
  parseTransferWindowUrl,
  transferRequestSchema,
  transferResponseSchema,
  transferWindowUrl,
} from './cross-origin-transfer-protocol.js'

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
      expect(foreign instanceof Uint8Array).toBe(false)
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

describe('the transfer result', () => {
  it('carries what the receiver merged, and a refusal carries a sentence', () => {
    const ok = transferResponseSchema.safeParse({
      type: 'transfer-result',
      nonce: NONCE,
      ok: true,
      workspaceId: 'ws-a',
      promotedDocumentIds: ['01ARZ3NDEKTSV4RRFFQ69G5FAV'],
      shadowedPaths: ['contested'],
      attested: true,
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

  it('refuses a refusal with no reason, since the sender shows the reason as-is', () => {
    const parsed = transferResponseSchema.safeParse({
      type: 'transfer-result',
      nonce: NONCE,
      ok: false,
      reason: '',
    })
    expect(parsed.success).toBe(false)
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
