/**
 * ADR-0046 decision 10 through server mode's `/mcp`, with the real JWT
 * validator and a real MCP client: a workspace an agent creates is its
 * person's, and another person's agent reaches it neither by reading nor by
 * "creating" it again.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { type CryptoKey, generateKeyPair, SignJWT } from 'jose'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer, resolveServerDeps } from '../di/container.js'
import type { ServerModeAppOptions } from './app.js'
import { createAdministratorCheck } from './security/administrator-check.js'
import { createInvitationStore } from './security/invitation-store.js'
import { createMemberProfileStore } from './security/member-profile-store.js'
import { createOAuthJwtValidator } from './security/oauth-jwt-validator.js'
import { createOAuthResourceServerAuthStrategy } from './security/oauth-resource-strategy.js'
import { signInConfigSchema } from './security/sign-in-config.js'
import { createSignInSessionStore } from './security/sign-in-session-store.js'
import { createTenantAdministratorStore } from './security/tenant-administrator-store.js'
import { createUserDeactivation } from './security/user-deactivation.js'
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
const PUBLIC_URL = 'https://board.example'

let privateKey: CryptoKey
let publicKey: CryptoKey
beforeAll(async () => {
  ;({ privateKey, publicKey } = await generateKeyPair('ES256'))
})

let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'wb-server-mode-mcp-membership-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  const members = createMemberProfileStore(handle.db)
  const providers = signInConfigSchema.parse({
    providers: [
      {
        id: 'corp',
        kind: 'oidc',
        issuer: ISSUER,
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
        audience: PUBLIC_URL,
        keyResolver: async () => publicKey,
      }),
    }),
    serverDeps: resolveServerDeps(createContainer()),
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
})
afterEach(async () => {
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

/** An MCP client for `sub`, holding a typed access token from `claude-code`. */
async function agentOf(sub: string) {
  const token = await new SignJWT({ azp: 'claude-code', scope: 'mcp:call', name: sub })
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt' })
    .setIssuer(ISSUER)
    .setAudience(PUBLIC_URL)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey)
  const client = new Client({ name: `agent-${sub}`, version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${PUBLIC_URL}/mcp`), {
    fetch: (input, init) => {
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
      }>,
    close: () => transport.close(),
  }
}

const textOf = (res: { content: Array<{ text?: string }> }) => res.content[0]?.text ?? ''

const createPlans = {
  workspaceId: 'plans',
  createWorkspace: true,
  ops: [{ op: 'document.create', path: 'notes', kind: 'markdown', markdown: 'hello' }],
}

describe('server mode /mcp — a workspace belongs to the people in it', () => {
  it("makes the creating agent's person its first member, and keeps another's out", async () => {
    const ada = await agentOf('ada')
    const eve = await agentOf('eve')
    try {
      const created = await ada.call('wb_workspace_edit', createPlans)
      expect(created.isError, textOf(created)).toBeFalsy()
      const listed = await ada.call('wb_document_list', { workspaceId: 'plans' })
      expect(listed.isError, textOf(listed)).toBeFalsy()

      const read = await eve.call('wb_document_list', { workspaceId: 'plans' })
      expect(read.isError).toBe(true)
      expect(textOf(read)).toMatch(/not_a_member/)

      // createWorkspace on an existing workspace is an ordinary write.
      const again = await eve.call('wb_workspace_edit', createPlans)
      expect(again.isError).toBe(true)
      expect(textOf(again)).toMatch(/not_a_member/)
    } finally {
      await ada.close()
      await eve.close()
    }
  })
})
