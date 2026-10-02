/**
 * ADR-0046 decision 1: server mode mounts the sign-in routes only when
 * providers are configured, and ahead of the placeholder page that would
 * otherwise answer every path.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { storeMemoryModule } from '../shared/test-utils/store-memory.module.js'
import type { ServerModeAppOptions } from './app.js'
import { testDataLayout } from './routes/_test-helpers.js'
import { DENY_ALL_STRATEGY, oidcProviders } from './security/_test-helpers.js'
import { signInConfigSchema } from './security/sign-in-config.js'

let tempDir: string

vi.mock('./config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
  DIST_WEB_APP_DIR: '/tmp/whiteboard/dist/web-app',
}))

const { createApp } = await import('./app.js')
const { createContainer, resolveServerDeps } = await import('../di/container.js')

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-server-mode-sign-in-'))
})
afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

const PUBLIC_URL = 'https://example.com'

function makeServerModeOptions(overrides?: Partial<ServerModeAppOptions>): ServerModeAppOptions {
  return {
    authMode: 'server-mode',
    publicBaseUrl: PUBLIC_URL,
    allowedOrigins: [PUBLIC_URL],
    // The root's deps, over the memory store: nothing here reads a document.
    serverDeps: resolveServerDeps(createContainer(storeMemoryModule)),
    dataLayout: testDataLayout(),
    authStrategy: DENY_ALL_STRATEGY,
    touch: () => {},
    getStatus: () => {
      throw new Error('not read by these routes')
    },
    ...overrides,
  }
}

describe('app — server-mode sign-in (ADR-0046)', () => {
  const [provider] = oidcProviders(
    signInConfigSchema.parse({
      providers: [
        {
          id: 'corp',
          kind: 'oidc',
          issuer: 'https://idp.test',
          clientId: 'wb',
          clientSecret: { env: 'X' },
        },
      ],
    }).providers,
  )
  if (provider === undefined) throw new Error('unreachable')

  const signIn = {
    providers: [{ ...provider, clientSecretValue: 's' }],
    rp: {
      authorizationUrl: async () => new URL('https://idp.test/authorize'),
      exchange: async () => ({}),
    },
    attempts: {
      begin: async () => ({
        state: 's',
        browserBinding: 'b',
        nonce: 'n',
        codeVerifier: 'v',
        providerId: 'corp',
        invitationToken: null,
        returnTo: '/',
      }),
      take: async () => null,
    },
    // Not reached by a sign-in's first leg.
    signIn: {} as never,
    publicBaseUrl: PUBLIC_URL,
  }

  it('mounts the sign-in routes ahead of the placeholder page when providers are configured', async () => {
    const app = createApp(makeServerModeOptions({ signIn }))
    const res = await app.request(`${PUBLIC_URL}/auth/sign-in/corp`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://idp.test/authorize')
  })

  it('offers no sign-in when none is configured', async () => {
    const app = createApp(makeServerModeOptions())
    const res = await app.request(`${PUBLIC_URL}/auth/sign-in/corp`)
    expect(res.status).not.toBe(302)
  })
})
