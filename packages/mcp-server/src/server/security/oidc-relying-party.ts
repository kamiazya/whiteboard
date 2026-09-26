/**
 * ADR-0046 decision 1: the keeper as an OpenID Connect relying party. The
 * protocol itself — discovery, PKCE, state and nonce checks, ID-token
 * signature and claims validation — is `openid-client` (OpenID Certified),
 * not code written here: hand-rolled relying parties are where this class of
 * bug lives. This module only adapts it to a configured provider.
 */
import * as client from 'openid-client'
import type { VerifiedClaims } from './sign-in-admission.js'
import type { OidcProvider, TrustedHeaderProvider } from './sign-in-config.js'

/** A provider with its client secret read from wherever the config named. */
/** A provider the keeper signs people in through with a browser: its client,
 *  and the secret it resolved at startup. */
export type ResolvedProvider = OidcProvider & {
  readonly clientId: string
  readonly clientSecretValue: string
}

/** What the configuration declares: browser-capable providers, bearer-only
 *  ones that carry no client, and reverse proxies that sign people in. */
export type ConfiguredProvider = OidcProvider | ResolvedProvider | TrustedHeaderProvider

export function signsInWithBrowser(provider: ConfiguredProvider): provider is ResolvedProvider {
  return 'clientSecretValue' in provider
}

interface AuthorizationRequest {
  readonly redirectUri: string
  readonly state: string
  readonly nonce: string
  readonly codeVerifier: string
  /** ADR-0051: the person signs in again interactively, whatever session the
   *  provider still holds (OIDC Core 1.0 section 3.1.2.1, `prompt=login` and
   *  `max_age=0`), so the ID token's `auth_time` is now. */
  readonly fresh?: boolean
}

export interface RelyingParty {
  authorizationUrl(provider: ResolvedProvider, request: AuthorizationRequest): Promise<URL>
  /** Exchanges the callback's code and answers the ID token's verified claims.
   *  Throws when the provider's answer fails any check. */
  exchange(
    provider: ResolvedProvider,
    callbackUrl: URL,
    checks: Omit<AuthorizationRequest, 'redirectUri'>,
  ): Promise<VerifiedClaims>
}

export function createRelyingParty(options: { fetch?: client.CustomFetch } = {}): RelyingParty {
  // Discovery once per provider; a failed discovery is not cached, so a
  // provider that was briefly down is retried on the next sign-in.
  const configs = new Map<string, Promise<client.Configuration>>()

  function configurationFor(provider: ResolvedProvider): Promise<client.Configuration> {
    const known = configs.get(provider.id)
    if (known !== undefined) return known
    const pending = client.discovery(
      new URL(provider.issuer),
      provider.clientId,
      undefined,
      client.ClientSecretPost(provider.clientSecretValue),
      options.fetch === undefined ? undefined : { [client.customFetch]: options.fetch },
    )
    configs.set(provider.id, pending)
    pending.catch(() => configs.delete(provider.id))
    return pending
  }

  return {
    async authorizationUrl(provider, { redirectUri, state, nonce, codeVerifier, fresh }) {
      return client.buildAuthorizationUrl(await configurationFor(provider), {
        redirect_uri: redirectUri,
        scope: provider.scopes.join(' '),
        state,
        nonce,
        code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: 'S256',
        ...(fresh === true ? { prompt: 'login', max_age: '0' } : {}),
      })
    },

    async exchange(provider, callbackUrl, { state, nonce, codeVerifier }) {
      const tokens = await client.authorizationCodeGrant(
        await configurationFor(provider),
        callbackUrl,
        {
          pkceCodeVerifier: codeVerifier,
          expectedState: state,
          expectedNonce: nonce,
          idTokenExpected: true,
        },
      )
      const claims = tokens.claims()
      if (claims === undefined) throw new Error('the provider returned no ID token')
      return claims
    },
  }
}
