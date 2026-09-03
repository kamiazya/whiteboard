import { describe, expect, it } from 'vitest'
import {
  buildMcpProtectedResourceMetadata,
  createLocalTokenMcpHttpAuthStrategy,
  resolveMcpProtectedResourceMetadataFromEnv,
} from './mcp-auth.js'

describe('MCP auth strategy', () => {
  it('parses protected resource metadata config from env', () => {
    expect(
      resolveMcpProtectedResourceMetadataFromEnv({
        WHITEBOARD_MCP_AUTHORIZATION_SERVER: 'https://auth.example.com',
        WHITEBOARD_MCP_RESOURCE: 'https://mcp.example.com/mcp',
        WHITEBOARD_MCP_SCOPES_SUPPORTED: 'canvas:read, canvas:write',
      }),
    ).toEqual({
      authorizationServers: ['https://auth.example.com'],
      resource: 'https://mcp.example.com/mcp',
      scopesSupported: ['canvas:read', 'canvas:write'],
    })
  })

  it('returns protected resource metadata when authorization server discovery is configured', () => {
    const strategy = createLocalTokenMcpHttpAuthStrategy({
      token: 'secret',
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

  it('builds a bearer challenge with resource metadata for unauthorized requests', () => {
    const strategy = createLocalTokenMcpHttpAuthStrategy({
      token: 'secret',
      protectedResourceMetadata: {
        authorizationServers: ['https://auth.example.com'],
      },
    })

    const decision = strategy.authorize({
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
