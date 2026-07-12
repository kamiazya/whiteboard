import { describe, expect, it } from 'vitest'
import {
  buildOAuthAuthorizationServerMetadata,
  buildOAuthProtectedResourceMetadata,
} from './oauth-authz-metadata.js'

describe('buildOAuthProtectedResourceMetadata', () => {
  it('describes the /api resource pointing back at this daemon as its own authorization server', () => {
    const metadata = buildOAuthProtectedResourceMetadata('http://127.0.0.1:3099/anything')
    expect(metadata).toEqual({
      resource: 'http://127.0.0.1:3099/api',
      authorization_servers: ['http://127.0.0.1:3099/'],
    })
  })
})

describe('buildOAuthAuthorizationServerMetadata', () => {
  it('declares PKCE-only, no-client-secret, authorization_code-only support', () => {
    const metadata = buildOAuthAuthorizationServerMetadata('http://127.0.0.1:3099/anything', [
      'workspace:read',
      'workspace:write',
    ])
    expect(metadata).toEqual({
      issuer: 'http://127.0.0.1:3099/',
      authorization_endpoint: 'http://127.0.0.1:3099/authorize',
      token_endpoint: 'http://127.0.0.1:3099/token',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['workspace:read', 'workspace:write'],
    })
  })
})
