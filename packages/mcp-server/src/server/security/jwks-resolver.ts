// Production JWKS key resolver for OAuthJwtValidator.
//
// Non-leak contract: errors from the remote key set (network failures,
// JWKS parse errors, unknown kid) are re-thrown as a bare Error with
// no message. The validator's wrappedKey guard already discards the
// thrown message; this layer is defense-in-depth so IdP URLs, JWKS
// credentials, and key IDs never propagate even if the guard changes.

import { type CryptoKey, createRemoteJWKSet, type FlattenedJWSInput } from 'jose'
import type { JwtKeyResolver } from './oauth-jwt-validator.js'

export function createJwksKeyResolver(jwksUri: string): JwtKeyResolver {
  const remoteKeySet = createRemoteJWKSet(new URL(jwksUri))
  return async (protectedHeader) => {
    try {
      // createRemoteJWKSet selects the key using protectedHeader.kid /
      // protectedHeader.alg only; the FlattenedJWSInput second argument
      // is not used for key selection, so a stub satisfies the call.
      const key = await remoteKeySet(protectedHeader, {
        payload: '',
        signature: '',
      } as FlattenedJWSInput)
      return key as CryptoKey | Uint8Array
    } catch {
      throw new Error()
    }
  }
}
