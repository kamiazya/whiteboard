/**
 * ADR-0046 decision 5 through server mode's whole `/api`, with the real JWT
 * validator: an MCP client's bearer from the provider's issuer, before anyone
 * signed in with a browser, becomes a user, creates a workspace and is its
 * first member — and a client the provider does not name is refused.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type CryptoKey, generateKeyPair, SignJWT } from 'jose'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer, resolveServerDeps } from '../di/container.js'
import type { ServerModeAppOptions } from './app.js'
import { createInvitationStore } from './security/invitation-store.js'
import { createMemberProfileStore } from './security/member-profile-store.js'
import { createOAuthJwtValidator } from './security/oauth-jwt-validator.js'
import { createOAuthResourceServerAuthStrategy } from './security/oauth-resource-strategy.js'
import { signInConfigSchema } from './security/sign-in-config.js'
import { createSignInSessionStore } from './security/sign-in-session-store.js'
import { createWorkspaceRoles } from './security/workspace-roles.js'
import { createIsolatedDb } from './store/db/test-helpers.js'

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

const ISSUER = 'https://idp.test'
const AUDIENCE = 'https://board.example'
const PUBLIC_URL = 'https://board.example'
const SCOPE = 'workspace:read workspace:write canvas:read canvas:write'

let privateKey: CryptoKey
let publicKey: CryptoKey
beforeAll(async () => {
  ;({ privateKey, publicKey } = await generateKeyPair('ES256'))
})

function accessToken(azp: string, sub: string) {
  return new SignJWT({ azp, name: sub, scope: SCOPE })
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey)
}

let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'wb-server-mode-bearer-user-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  const members = createMemberProfileStore(handle.db)
  const providers = signInConfigSchema.parse({
    providers: [
      {
        id: 'corp',
        kind: 'oidc',
        issuer: ISSUER,
        clientId: 'wb-web',
        clientSecret: { env: 'CORP_SECRET' },
        admission: { createAccounts: true, bearerClients: ['claude-code'] },
      },
    ],
  }).providers
  const options: ServerModeAppOptions = {
    authMode: 'server-mode',
    publicBaseUrl: PUBLIC_URL,
    allowedOrigins: [PUBLIC_URL],
    authStrategy: createOAuthResourceServerAuthStrategy({
      validator: createOAuthJwtValidator({
        issuer: ISSUER,
        audience: AUDIENCE,
        keyResolver: async () => publicKey,
      }),
    }),
    serverDeps: resolveServerDeps(createContainer()),
    people: {
      members,
      sessions: createSignInSessionStore(handle.db),
      roles: createWorkspaceRoles(handle.db),
      invitations: createInvitationStore(handle.db),
      origin: PUBLIC_URL,
      bearerProvisioning: { providers, members },
    },
    touch: () => {},
    getStatus: () => {
      throw new Error('not read by these routes')
    },
  }
  app = createApp(options)
})
afterEach(async () => {
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

async function as(azp: string, sub: string) {
  return { authorization: `Bearer ${await accessToken(azp, sub)}` }
}

describe('server mode — an MCP client with no browser sign-in', () => {
  it('becomes a user, creates a workspace, and is its first member', async () => {
    const ada = await as('claude-code', 'ada')
    const created = await app.request(`${PUBLIC_URL}/api/workspaces`, {
      method: 'POST',
      headers: { ...ada, 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Plans' }),
    })
    expect(created.status).toBe(201)
    const { workspaceId } = (await created.json()) as { workspaceId: string }

    const read = await app.request(`${PUBLIC_URL}/api/workspaces/${workspaceId}/documents`, {
      headers: ada,
    })
    expect(read.status).toBe(200)
  })

  it('is refused, by reason, from a client the provider does not name', async () => {
    const res = await app.request(`${PUBLIC_URL}/api/workspaces`, {
      headers: await as('other-app', 'ada'),
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'client_not_allowed' })
  })
})
