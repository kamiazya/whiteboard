/**
 * A signed assertion is admitted exactly when every claim the reader requires is
 * present and right. The expectation is computed from the generated shape, never
 * from the reader's own claim list, so the property cannot agree with a
 * dropped requirement by construction.
 */
import { exportJWK, generateKeyPair, importJWK, SignJWT } from 'jose'
import { afterAll, beforeAll, describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../../shared/test-utils/fast-check.js'
import { signInConfigSchema, type TrustedHeaderProvider } from './sign-in-config.js'
import { createTrustedIdentityReader } from './trusted-header-identity.js'

const ISSUER = 'https://team.cloudflareaccess.com'
const [parsed] = signInConfigSchema.parse({
  providers: [
    {
      id: 'access',
      kind: 'trusted-header',
      trustedAddresses: ['127.0.0.1'],
      assertion: {
        header: 'Cf-Access-Jwt-Assertion',
        issuer: ISSUER,
        audience: 'aud-1',
        jwksUri: `${ISSUER}/cdn-cgi/access/certs`,
      },
    },
  ],
}).providers
const provider = parsed as TrustedHeaderProvider

interface Shape {
  readonly exp: 'none' | 'future' | 'past'
  readonly sub: 'none' | 'present'
  readonly aud: 'right' | 'wrong'
  readonly iss: 'right' | 'wrong'
}

const shapeArb: fc.Arbitrary<Shape> = fc.record({
  exp: fc.constantFrom('none', 'future', 'past'),
  sub: fc.constantFrom('none', 'present'),
  aud: fc.constantFrom('right', 'wrong'),
  iss: fc.constantFrom('right', 'wrong'),
})

const sound = (s: Shape) =>
  s.exp === 'future' && s.sub === 'present' && s.aud === 'right' && s.iss === 'right'

// Each property only asserts inside a branch; these count how often both
// were entered, so a generator that stopped reaching one fails here.
const reached = { admitted: 0, noExp: 0, noSub: 0 }

describe('a signed assertion — every required claim is required', () => {
  let key: CryptoKey
  let read: ReturnType<typeof createTrustedIdentityReader>

  beforeAll(async () => {
    const pair = await generateKeyPair('ES256')
    key = pair.privateKey
    const jwk = await exportJWK(pair.publicKey)
    read = createTrustedIdentityReader(provider, () => importJWK(jwk, 'ES256'))
  })

  afterAll(() => {
    expect(reached.admitted).toBeGreaterThan(0)
    expect(reached.noExp).toBeGreaterThan(0)
    expect(reached.noSub).toBeGreaterThan(0)
  })

  fcTest.prop([shapeArb], withDefaults())(
    'is admitted exactly when it has a future exp, a sub, and the right audience and issuer',
    async (shape) => {
      const jwt = new SignJWT({ email: 'ada@corp.example' })
        .setProtectedHeader({ alg: 'ES256' })
        .setIssuer(shape.iss === 'right' ? ISSUER : 'https://evil.example')
        .setAudience(shape.aud === 'right' ? 'aud-1' : 'aud-2')
        .setIssuedAt()
      if (shape.sub === 'present') jwt.setSubject('user-1')
      if (shape.exp !== 'none') jwt.setExpirationTime(shape.exp === 'future' ? '5m' : '-5m')
      const assertion = await jwt.sign(key)

      const identity = await read({
        peer: '127.0.0.1',
        header: (name) =>
          name.toLowerCase() === 'cf-access-jwt-assertion' ? assertion : undefined,
      })

      if (sound(shape)) reached.admitted++
      if (shape.exp === 'none' && shape.sub === 'present') reached.noExp++
      if (shape.sub === 'none' && shape.exp === 'future') reached.noSub++
      expect(identity.ok).toBe(sound(shape))
    },
  )
})
