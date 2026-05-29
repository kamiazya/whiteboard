import type { CryptoKey } from 'jose'
import { describe, expect, it, vi } from 'vitest'

// Mock jose before importing the module under test.
// vi.mock is hoisted to the top of the file.
vi.mock('jose', async (importOriginal) => {
  const original = await importOriginal<typeof import('jose')>()
  return {
    ...original,
    createRemoteJWKSet: vi.fn(),
  }
})

import { createRemoteJWKSet } from 'jose'
import { createJwksKeyResolver } from './jwks-resolver.js'

const mockCreateRemoteJWKSet = vi.mocked(createRemoteJWKSet)

describe('createJwksKeyResolver', () => {
  it('calls createRemoteJWKSet with the parsed URL', () => {
    const mockFn = vi.fn().mockResolvedValue({} as CryptoKey)
    mockCreateRemoteJWKSet.mockReturnValue(mockFn as ReturnType<typeof createRemoteJWKSet>)

    createJwksKeyResolver('https://auth.example.com/.well-known/jwks.json')

    expect(mockCreateRemoteJWKSet).toHaveBeenCalledWith(
      new URL('https://auth.example.com/.well-known/jwks.json'),
    )
  })

  it('returns the key from the remote key set', async () => {
    const mockKey = {} as CryptoKey
    const mockFn = vi.fn().mockResolvedValue(mockKey)
    mockCreateRemoteJWKSet.mockReturnValue(mockFn as ReturnType<typeof createRemoteJWKSet>)

    const resolver = createJwksKeyResolver('https://auth.example.com/.well-known/jwks.json')
    const header = { alg: 'RS256', kid: 'test-key' }
    const result = await resolver(header)

    expect(result).toBe(mockKey)
    expect(mockFn).toHaveBeenCalledWith(header, { payload: '', signature: '' })
  })

  it('re-throws remote key set errors as bare Error (no message)', async () => {
    const mockFn = vi.fn().mockRejectedValue(
      new Error('JWKSNoMatchingKey: https://auth.example.com/jwks – kid=test, alg=RS256'),
    )
    mockCreateRemoteJWKSet.mockReturnValue(mockFn as ReturnType<typeof createRemoteJWKSet>)

    const resolver = createJwksKeyResolver('https://auth.example.com/.well-known/jwks.json')

    await expect(resolver({ alg: 'RS256' })).rejects.toThrow()

    // The thrown error must not contain the original message (URL, kid, etc.)
    try {
      await resolver({ alg: 'RS256' })
    } catch (err) {
      expect((err as Error).message).toBe('')
    }
  })

  it('re-throws network errors as bare Error (no URL in message)', async () => {
    const mockFn = vi.fn().mockRejectedValue(
      new TypeError('fetch failed: ECONNREFUSED https://secret-auth.internal/jwks'),
    )
    mockCreateRemoteJWKSet.mockReturnValue(mockFn as ReturnType<typeof createRemoteJWKSet>)

    const resolver = createJwksKeyResolver('https://secret-auth.internal/jwks')

    try {
      await resolver({ alg: 'ES256' })
      expect.fail('should have thrown')
    } catch (err) {
      expect((err as Error).message).toBe('')
      expect(String(err)).not.toContain('secret-auth.internal')
    }
  })
})
