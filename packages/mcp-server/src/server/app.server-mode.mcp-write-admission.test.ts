/**
 * The `/mcp` gate judges membership when a tool call starts, and the call's
 * writes are made later — behind another writer on the workspace's write
 * lock, or many ops into a batch. A person removed in between must not have
 * the write land: as over `/api`, each write lock the call enters for the
 * workspace it was admitted to checks membership again. Driven through a real
 * MCP client against server mode's whole app.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { type CryptoKey, generateKeyPair, SignJWT } from 'jose'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerModeAppOptions } from './app.js'
import { resolveTestServerDeps, testDataLayout } from './routes/_test-helpers.js'
import { oidcProviders } from './security/_test-helpers.js'
import { createAdministratorCheck } from './security/administrator-check.js'
import { createInvitationStore } from './security/invitation-store.js'
import { createMemberProfileStore } from './security/member-profile-store.js'
import { createOAuthJwtValidator } from './security/oauth-jwt-validator.js'
import { createOAuthResourceServerAuthStrategy } from './security/oauth-resource-strategy.js'
import { providerAuthenticator, signInConfigSchema } from './security/sign-in-config.js'
import { createSignInSessionStore } from './security/sign-in-session-store.js'
import { createTenantAdministratorStore } from './security/tenant-administrator-store.js'
import { createUserDeactivation } from './security/user-deactivation.js'
import { createUserDeletion } from './security/user-deletion.js'
import { createWorkspaceRoles } from './security/workspace-roles.js'
import { createIsolatedDb } from './store/db/test-helpers.js'
import { withWorkspaceWriteLock } from './store/workspace-lock.js'

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
const PUBLIC_URL = 'https://board.example'

let privateKey: CryptoKey
let publicKey: CryptoKey
beforeAll(async () => {
  ;({ privateKey, publicKey } = await generateKeyPair('ES256'))
})

let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let app: ReturnType<typeof createApp>
let layout: ReturnType<typeof testDataLayout>
let options: ServerModeAppOptions
let createsEntered = 0

/**
 * The deps with `createDocument` counted on entry. The index takes the
 * workspace's write lock inside it, so a call counted here has passed the
 * gate and is the one waiting on the lock — the moment this test needs.
 */
function enteringCreate(deps: ServerDeps): ServerDeps {
  const index = deps.documentIndex
  const documentIndex = new Proxy(index, {
    get(target, key) {
      const value = Reflect.get(target, key, target)
      if (typeof value !== 'function') return value
      if (key !== 'createDocument') return value.bind(target)
      return (...args: unknown[]) => {
        createsEntered += 1
        return value.apply(target, args)
      }
    },
  })
  return { ...deps, documentIndex }
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'wb-server-mode-mcp-write-admission-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  layout = testDataLayout()
  const members = createMemberProfileStore(handle.db)
  const providers = oidcProviders(
    signInConfigSchema.parse({
      providers: [
        {
          id: 'corp',
          kind: 'oidc',
          issuer: ISSUER,
          admission: { createAccounts: true, bearerClients: ['claude-code'] },
        },
      ],
    }).providers,
  )
  options = {
    authMode: 'server-mode',
    publicBaseUrl: PUBLIC_URL,
    allowedOrigins: [PUBLIC_URL],
    authStrategy: createOAuthResourceServerAuthStrategy({
      validator: createOAuthJwtValidator({
        issuer: ISSUER,
        audience: PUBLIC_URL,
        keyResolver: async () => publicKey,
      }),
    }),
    serverDeps: enteringCreate(await resolveTestServerDeps(tempDir)),
    dataLayout: layout,
    people: {
      members,
      sessions: createSignInSessionStore(handle.db),
      roles: createWorkspaceRoles(handle.db),
      invitations: createInvitationStore(handle.db),
      administration: {
        check: createAdministratorCheck({
          admins: createTenantAdministratorStore(handle.db),
          members: createMemberProfileStore(handle.db),
          configured: [],
        }),
        appointments: createTenantAdministratorStore(handle.db),
        deactivation: createUserDeactivation(handle.db),
        deletion: createUserDeletion(handle.db, async () => {}),
      },
      origin: PUBLIC_URL,
      bearerProvisioning: { providers, members },
    },
    touch: () => {},
    getStatus: () => {
      throw new Error('not read by these routes')
    },
  }
  app = createApp(options)
  createsEntered = 0
})
afterEach(async () => {
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

// Everything a tool on /mcp can need, so the membership cases below are about
// membership alone.
const FULL_SCOPE =
  'mcp:call canvas:read canvas:write workspace:read workspace:write versions:read versions:write'

/** A typed access token from `claude-code` for `sub`. */
function tokenFor(sub: string, scope: string) {
  return new SignJWT({ azp: 'claude-code', scope, name: sub })
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt' })
    .setIssuer(ISSUER)
    .setAudience(PUBLIC_URL)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey)
}

/** An MCP client for `sub`, holding a typed access token from `claude-code`. */
async function agentOf(sub: string, scope = FULL_SCOPE) {
  const token = await tokenFor(sub, scope)
  const client = new Client({ name: `agent-${sub}`, version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${PUBLIC_URL}/mcp`), {
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers)
      headers.set('Authorization', `Bearer ${token}`)
      return app.request(input instanceof URL ? input.toString() : String(input), {
        ...init,
        headers,
      })
    },
  })
  await client.connect(transport)
  return {
    call: (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args }) as Promise<{
        isError?: boolean
        content: Array<{ text?: string }>
        structuredContent?: Record<string, unknown>
      }>,
    close: () => transport.close(),
  }
}

const textOf = (res: { content: Array<{ text?: string }> }) => res.content[0]?.text ?? ''

const pathsOf = (listed: { structuredContent?: Record<string, unknown> }) =>
  ((listed.structuredContent?.documents ?? []) as { path: string }[]).map((d) => d.path)

/** ada owns `plans`, bob is a member of it; the canonical id and bob's user. */
async function sharedPlans(ada: Agent, bob: Agent) {
  const created = await ada.call('wb_workspace_edit', {
    workspaceId: 'plans',
    createWorkspace: true,
    ops: [{ op: 'document.create', path: 'notes', kind: 'markdown' }],
  })
  expect(created.isError, textOf(created)).toBeFalsy()
  const workspaceId = created.structuredContent?.workspaceId as string
  // bob's first call provisions his profile; he is not in the workspace yet.
  expect((await bob.call('wb_document_list', { workspaceId })).isError).toBe(true)
  const bobProfile = await options.people.members.profileForBinding({
    authenticator: providerAuthenticator({ issuer: ISSUER }),
    subject: 'bob',
  })
  if (bobProfile === null) throw new Error('bob was not provisioned')
  await options.people.members.addMember(workspaceId, bobProfile.id)
  return { workspaceId, bobId: bobProfile.id }
}

/** Holds `workspaceId`'s write lock until `release` is called. */
function holdWriteLock(workspaceId: string) {
  let release = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const held = withWorkspaceWriteLock(workspaceId, () => released)
  return { release, held }
}

type Agent = Awaited<ReturnType<typeof agentOf>>

describe('server mode /mcp — a write outliving its membership', () => {
  it('lands for a member who is still one when the lock frees', async () => {
    const ada = await agentOf('ada')
    const bob = await agentOf('bob')
    try {
      const { workspaceId } = await sharedPlans(ada, bob)
      const lock = holdWriteLock(workspaceId)
      const entered = createsEntered
      const call = bob.call('wb_workspace_edit', {
        workspaceId,
        ops: [{ op: 'document.create', path: 'bobs', kind: 'markdown' }],
      })
      await vi.waitFor(() => expect(createsEntered).toBeGreaterThan(entered))
      lock.release()
      await lock.held

      const res = await call
      expect(res.isError, textOf(res)).toBeFalsy()
      expect(pathsOf(await ada.call('wb_document_list', { workspaceId }))).toContain('bobs')
    } finally {
      await ada.close()
      await bob.close()
    }
  })

  it('is refused for a member removed while the call waited on the lock', async () => {
    const ada = await agentOf('ada')
    const bob = await agentOf('bob')
    try {
      const { workspaceId, bobId } = await sharedPlans(ada, bob)
      const lock = holdWriteLock(workspaceId)
      const entered = createsEntered
      const call = bob.call('wb_workspace_edit', {
        workspaceId,
        ops: [{ op: 'document.create', path: 'bobs', kind: 'markdown' }],
      })
      await vi.waitFor(() => expect(createsEntered).toBeGreaterThan(entered))

      expect(await options.people.roles.remove(workspaceId, bobId)).toBe('ok')
      lock.release()
      await lock.held

      const res = await call
      expect(res.isError).toBe(true)
      expect(textOf(res)).toMatch(/not_a_member/)
      expect(pathsOf(await ada.call('wb_document_list', { workspaceId }))).toEqual(['notes'])
    } finally {
      await ada.close()
      await bob.close()
    }
  })
})
