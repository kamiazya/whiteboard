import { describe, expect, it } from 'vitest'
import { createCredentialResolver } from './credential-resolver.js'
import { mintMacaroon } from './macaroon.js'
import {
  buildMcpProtectedResourceMetadata,
  createLocalTokenMcpHttpAuthStrategy,
  type McpHttpAuthStrategy,
  requiresMcpHttpAuth,
} from './mcp-auth.js'

describe('requiresMcpHttpAuth', () => {
  it('requires auth for MCP HTTP requests except preflight', () => {
    expect(requiresMcpHttpAuth('GET')).toBe(true)
    expect(requiresMcpHttpAuth('POST')).toBe(true)
    expect(requiresMcpHttpAuth('DELETE')).toBe(true)
    expect(requiresMcpHttpAuth('OPTIONS')).toBe(false)
  })
})

describe('MCP auth strategy', () => {
  it('returns protected resource metadata when authorization server discovery is configured', () => {
    const strategy = createLocalTokenMcpHttpAuthStrategy({
      resolver: createCredentialResolver({ daemonToken: 'secret' }),
      protectedResourceMetadata: {
        authorizationServers: ['https://auth.example.com'],
        scopesSupported: ['canvas:read', 'canvas:write'],
      },
    })

    expect(buildMcpProtectedResourceMetadata(strategy, 'https://mcp.example.com/mcp')).toEqual({
      resource: 'https://mcp.example.com/mcp',
      authorization_servers: ['https://auth.example.com'],
      scopes_supported: ['canvas:read', 'canvas:write'],
    })
  })

  it('builds a bearer challenge with resource metadata for unauthorized requests', async () => {
    const strategy = createLocalTokenMcpHttpAuthStrategy({
      resolver: createCredentialResolver({ daemonToken: 'secret' }),
      protectedResourceMetadata: {
        authorizationServers: ['https://auth.example.com'],
      },
    })

    const decision = await strategy.authorize({
      method: 'POST',
      authorizationHeader: undefined,
      requestUrl: 'https://mcp.example.com/mcp',
    })

    expect(decision.ok).toBe(false)
    if (decision.ok) {
      throw new Error('expected unauthorized decision')
    }
    expect(decision.status).toBe(401)
    expect(decision.headers.get('WWW-Authenticate')).toBe(
      'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
    )
  })
})

/**
 * Which GRANTS `/mcp` admits, as opposed to which credentials verify.
 *
 * Every case here was previously a 401 for the same reason — the surface
 * admitted two kinds and refused the rest — so the refusals below are only
 * meaningful beside the admissions they sit with.
 */
describe('what reaches /mcp in local-daemon mode', () => {
  const ROOT_KEY = new Uint8Array(32).fill(7)

  const post = (strategy: McpHttpAuthStrategy, authorizationHeader?: string) =>
    strategy.authorize({
      method: 'POST',
      authorizationHeader,
      requestUrl: 'http://localhost/mcp',
    })

  it('admits the daemon token, which holds every scope', async () => {
    const strategy = createLocalTokenMcpHttpAuthStrategy({
      resolver: createCredentialResolver({ daemonToken: 'secret' }),
    })

    expect(await post(strategy, 'Bearer secret')).toEqual({ ok: true })
  })

  it('admits every caller on a daemon with no token configured', async () => {
    const strategy = createLocalTokenMcpHttpAuthStrategy({
      resolver: createCredentialResolver({}),
    })

    expect(await post(strategy)).toEqual({ ok: true })
  })

  it('admits a macaroon that carries mcp:call', async () => {
    const token = await mintMacaroon({
      rootKey: ROOT_KEY,
      tokenId: 'agent-1',
      caveats: [{ kind: 'scope', scopes: ['canvas:read', 'mcp:call'] }],
    })
    const strategy = createLocalTokenMcpHttpAuthStrategy({
      resolver: createCredentialResolver({ daemonToken: 'secret', macaroonRootKey: ROOT_KEY }),
    })

    expect(await post(strategy, `Bearer ${token}`)).toEqual({ ok: true })
  })

  it('refuses a macaroon attenuated below mcp:call with 403', async () => {
    const token = await mintMacaroon({
      rootKey: ROOT_KEY,
      tokenId: 'agent-1',
      caveats: [{ kind: 'scope', scopes: ['canvas:read'] }],
    })
    const strategy = createLocalTokenMcpHttpAuthStrategy({
      resolver: createCredentialResolver({ daemonToken: 'secret', macaroonRootKey: ROOT_KEY }),
    })

    const decision = await post(strategy, `Bearer ${token}`)
    if (decision.ok) throw new Error('expected a refusal')
    // 403, not 401: the credential verified and is understood. Re-presenting
    // it cannot help, so there is no `WWW-Authenticate` challenge to offer.
    expect(decision.status).toBe(403)
    expect(decision.headers.get('WWW-Authenticate')).toBeNull()
  })

  it('still answers 401 with a challenge when nothing verifies', async () => {
    const strategy = createLocalTokenMcpHttpAuthStrategy({
      resolver: createCredentialResolver({ daemonToken: 'secret' }),
      protectedResourceMetadata: { authorizationServers: ['https://auth.example.com'] },
    })

    const decision = await post(strategy, 'Bearer forged')
    if (decision.ok) throw new Error('expected a refusal')
    expect(decision.status).toBe(401)
    expect(decision.headers.get('WWW-Authenticate')).toContain('Bearer')
  })
})
