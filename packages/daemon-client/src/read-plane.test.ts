import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  deriveDocumentKey,
  deriveDocumentKeyBytes,
  epochSchema,
  openBytes,
  sealBytes,
  sealedEnvelopeSchema,
} from './read-plane.js'

// Fixed inputs shared by every golden vector below. The expected hex was
// computed independently with node:crypto's hkdfSync in a scratch script
// (never committed) and cross-checked against a bare crypto.subtle.deriveBits
// call before being pasted here — this test must not derive its own
// expectation with the code under test.
const workspaceKey = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const workspaceKeySalt = Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i)

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

describe('deriveDocumentKeyBytes: golden vectors (RFC 5869 HKDF-SHA-256)', () => {
  const GOLDEN: Array<{ docKey: string; epoch: number; expectedHex: string }> = [
    {
      docKey: 'docA',
      epoch: 0,
      expectedHex: 'e8a9cd79125db507eb53b8892ae335e13954812cc4feae066644d5171541d99b',
    },
    {
      docKey: 'docB',
      epoch: 0,
      expectedHex: '57afe9801a0f5b4d087122e17b41f45f6a7b51130fb72344c867a6a100860312',
    },
    {
      docKey: 'docA',
      epoch: 1,
      expectedHex: '6ce680be830696d4a60ab7afdb615437b95f39eba10181e855e819f5040069ea',
    },
    // Collision pair: bare string concatenation of docKey + epoch would
    // collide here ("a1" + "2" === "a" + "12" === "a12"), which is exactly
    // the boundary ambiguity JSON-array encoding (['a','bc'] vs ['ab','c'])
    // exists to rule out. Mutation check (a) drops the array encoding for
    // concatenation and expects these two golden values to become equal.
    {
      docKey: 'a1',
      epoch: 2,
      expectedHex: '76b24c4677706c1a041f36cafd9066c1f27885e14a854446b1e33acd7bcbb57e',
    },
    {
      docKey: 'a',
      epoch: 12,
      expectedHex: 'b6c7f54f2887f226bdbe662b7f867df11ce0f42f9e2f720ecb97acd0853c4ba4',
    },
  ]

  it.each(GOLDEN)('($docKey, $epoch) matches its independently-computed hex', async ({
    docKey,
    epoch,
    expectedHex,
  }) => {
    const bytes = await deriveDocumentKeyBytes({
      workspaceKey,
      workspaceKeySalt,
      docKey,
      epoch,
    })
    expect(hex(bytes)).toBe(expectedHex)
  })

  it('every golden key is pairwise distinct (JSON-array info separates every pair)', async () => {
    const derived = await Promise.all(
      GOLDEN.map(({ docKey, epoch }) =>
        deriveDocumentKeyBytes({ workspaceKey, workspaceKeySalt, docKey, epoch }),
      ),
    )
    const hexes = derived.map(hex)
    expect(new Set(hexes).size).toBe(hexes.length)
  })
})

describe('sealBytes: the additional data it binds', () => {
  // The golden vectors above pin the HKDF info; this pins the AEAD's twin. The
  // aad is written out literally here rather than built by the code under
  // test, so a change to what a sealed envelope is bound to — the tag, the
  // key's name, the order — fails on bytes already on disk, which a
  // round-trip through the same encoder would never notice.
  it('seals under the aad ["wb-doc-aad-v1", docKey, epoch], so an independent decrypt opens it', async () => {
    const key = await deriveDocumentKey({
      workspaceKey,
      workspaceKeySalt,
      docKey: 'workspace-tree:ws-1',
      epoch: 3,
    })
    const envelope = await sealBytes(key, new TextEncoder().encode('payload'), {
      docKey: 'workspace-tree:ws-1',
      epoch: 3,
    })
    const additionalData = new TextEncoder().encode('["wb-doc-aad-v1","workspace-tree:ws-1",3]')
    const opened = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: envelope.iv, additionalData },
      key,
      envelope.ct,
    )
    expect(new TextDecoder().decode(opened)).toBe('payload')
  })
})

describe('deriveDocumentKey', () => {
  it('returns a non-extractable AES-GCM CryptoKey usable for encrypt+decrypt', async () => {
    const key = await deriveDocumentKey({
      workspaceKey,
      workspaceKeySalt,
      docKey: 'docA',
      epoch: 0,
    })
    expect(key.extractable).toBe(false)
    expect(key.algorithm.name).toBe('AES-GCM')
    expect(key.usages.sort()).toEqual(['decrypt', 'encrypt'])
  })

  it('rejects a workspaceKey that is not 32 bytes before any subtle call', async () => {
    await expect(
      deriveDocumentKey({
        workspaceKey: new Uint8Array(31),
        workspaceKeySalt,
        docKey: 'docA',
        epoch: 0,
      }),
    ).rejects.toBeInstanceOf(RangeError)
  })
})

describe('sealBytes: fresh IV', () => {
  it('two seals of the same plaintext under the same key differ in iv and ct', async () => {
    const key = await deriveDocumentKey({
      workspaceKey,
      workspaceKeySalt,
      docKey: 'docA',
      epoch: 0,
    })
    const context = { docKey: 'docA', epoch: 0 }
    const plaintext = new TextEncoder().encode('hello read plane')

    const first = await sealBytes(key, plaintext, context)
    const second = await sealBytes(key, plaintext, context)

    expect(first.iv.length).toBe(12)
    expect(hex(first.iv)).not.toBe(hex(second.iv))
    expect(hex(first.ct)).not.toBe(hex(second.ct))
  })
})

describe('sealBytes / openBytes: tamper detection', () => {
  async function sealFixture() {
    const key = await deriveDocumentKey({
      workspaceKey,
      workspaceKeySalt,
      docKey: 'docA',
      epoch: 0,
    })
    const context = { docKey: 'docA', epoch: 0 }
    const envelope = await sealBytes(key, new TextEncoder().encode('secret bytes'), context)
    return { key, context, envelope }
  }

  it('flipping a ct byte makes openBytes reject with OperationError', async () => {
    const { key, context, envelope } = await sealFixture()
    const tampered = { ...envelope, ct: envelope.ct.slice() }
    tampered.ct[0] ^= 0xff
    await expect(openBytes(key, tampered, context)).rejects.toMatchObject({
      name: 'OperationError',
    })
  })

  it('flipping an iv byte makes openBytes reject with OperationError', async () => {
    const { key, context, envelope } = await sealFixture()
    const tampered = { ...envelope, iv: envelope.iv.slice() }
    tampered.iv[0] ^= 0xff
    await expect(openBytes(key, tampered, context)).rejects.toMatchObject({
      name: 'OperationError',
    })
  })

  it('opening under a different docKey (changed aad) rejects with OperationError', async () => {
    const { key, envelope } = await sealFixture()
    await expect(openBytes(key, envelope, { docKey: 'docB', epoch: 0 })).rejects.toMatchObject({
      name: 'OperationError',
    })
  })

  it('opening under a bumped epoch (changed aad) rejects with OperationError', async () => {
    const { key, envelope, context } = await sealFixture()
    await expect(
      openBytes(key, envelope, { ...context, epoch: context.epoch + 1 }),
    ).rejects.toMatchObject({
      name: 'OperationError',
    })
  })

  it('round-trips a genuine seal/open with no tamper', async () => {
    const { key, context, envelope } = await sealFixture()
    const opened = await openBytes(key, envelope, context)
    expect(opened).toEqual(new TextEncoder().encode('secret bytes'))
  })
})

describe('contextBytes: non-finite epoch is rejected before HKDF info / AEAD aad', () => {
  // NaN, Infinity and -Infinity all JSON.stringify to `null`, so a context
  // carrying any of them would silently collide with every other one under
  // the same (tag, docKey) unless epochSchema refuses them first.
  it.each([
    NaN,
    Infinity,
    -Infinity,
    -1,
    1.5,
  ])('deriveDocumentKeyBytes rejects epoch=%s', async (epoch) => {
    await expect(
      deriveDocumentKeyBytes({ workspaceKey, workspaceKeySalt, docKey: 'docA', epoch }),
    ).rejects.toThrow()
  })

  it('sealBytes rejects a non-finite epoch in its context', async () => {
    const key = await deriveDocumentKey({
      workspaceKey,
      workspaceKeySalt,
      docKey: 'docA',
      epoch: 0,
    })
    await expect(
      sealBytes(key, new TextEncoder().encode('x'), { docKey: 'docA', epoch: NaN }),
    ).rejects.toThrow()
  })

  it('openBytes rejects a non-finite epoch in its context', async () => {
    const key = await deriveDocumentKey({
      workspaceKey,
      workspaceKeySalt,
      docKey: 'docA',
      epoch: 0,
    })
    const envelope = await sealBytes(key, new TextEncoder().encode('x'), {
      docKey: 'docA',
      epoch: 0,
    })
    await expect(openBytes(key, envelope, { docKey: 'docA', epoch: NaN })).rejects.toThrow()
  })
})

describe('sealedEnvelopeSchema', () => {
  const validEnvelope = { v: 1 as const, iv: new Uint8Array(12), ct: new Uint8Array(16), epoch: 0 }

  it('rejects v !== 1', () => {
    expect(sealedEnvelopeSchema.safeParse({ ...validEnvelope, v: 2 }).success).toBe(false)
  })

  it('rejects an iv of length 11', () => {
    expect(
      sealedEnvelopeSchema.safeParse({ ...validEnvelope, iv: new Uint8Array(11) }).success,
    ).toBe(false)
  })

  it('rejects an iv of length 13', () => {
    expect(
      sealedEnvelopeSchema.safeParse({ ...validEnvelope, iv: new Uint8Array(13) }).success,
    ).toBe(false)
  })

  it('rejects a negative epoch', () => {
    expect(epochSchema.safeParse(-1).success).toBe(false)
    expect(sealedEnvelopeSchema.safeParse({ ...validEnvelope, epoch: -1 }).success).toBe(false)
  })

  it('rejects a non-integer epoch', () => {
    expect(epochSchema.safeParse(1.5).success).toBe(false)
    expect(sealedEnvelopeSchema.safeParse({ ...validEnvelope, epoch: 1.5 }).success).toBe(false)
  })

  it('rejects ct given as a plain array rather than Uint8Array', () => {
    expect(sealedEnvelopeSchema.safeParse({ ...validEnvelope, ct: [1, 2, 3] }).success).toBe(false)
  })

  it('rejects an envelope carrying an unknown extra key (strict envelope shape)', () => {
    expect(sealedEnvelopeSchema.safeParse({ ...validEnvelope, extra: 'unexpected' }).success).toBe(
      false,
    )
  })

  it('accepts a cross-realm Uint8Array (structured-clone shape), judged by tag not instanceof', () => {
    // node:vm gives a genuinely different realm: its Uint8Array fails
    // `instanceof` against this file's Uint8Array even though it carries
    // the same '[object Uint8Array]' tag — the same shape IndexedDB hands
    // back after a structured clone (see memory: IDB clone defeats instanceof).
    const crossRealmIv = runInNewContext('new Uint8Array(12)') as Uint8Array
    const crossRealmCt = runInNewContext('new Uint8Array(16)') as Uint8Array
    expect(crossRealmIv).not.toBeInstanceOf(Uint8Array)
    const result = sealedEnvelopeSchema.safeParse({
      ...validEnvelope,
      iv: crossRealmIv,
      ct: crossRealmCt,
    })
    expect(result.success).toBe(true)
  })
})
