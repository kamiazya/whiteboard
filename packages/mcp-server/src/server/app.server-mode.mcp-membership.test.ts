/**
 * ADR-0046 decision 10 through server mode's `/mcp`, with the real JWT
 * validator and a real MCP client: a workspace an agent creates is its
 * person's, and another person's agent reaches it neither by reading nor by
 * "creating" it again — a create naming its segment mints that agent's own
 * (ADR-0053).
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { type CryptoKey, generateKeyPair, SignJWT } from 'jose'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { bootSelfHostDeps } from '../di/boot-self-host-deps.js'
import { createContainer, resolveServerDeps } from '../di/container.js'
import { storeMemoryModule } from '../shared/test-utils/store-memory.module.js'
import type { ServerModeAppOptions } from './app.js'
import { testDataLayout } from './routes/_test-helpers.js'
import { oidcProviders } from './security/_test-helpers.js'
import { createAdministratorCheck } from './security/administrator-check.js'
import { createInvitationStore } from './security/invitation-store.js'
import { createMemberProfileStore } from './security/member-profile-store.js'
import { createOAuthJwtValidator } from './security/oauth-jwt-validator.js'
import { createOAuthResourceServerAuthStrategy } from './security/oauth-resource-strategy.js'
import { signInConfigSchema } from './security/sign-in-config.js'
import { createSignInSessionStore } from './security/sign-in-session-store.js'
import { createTenantAdministratorStore } from './security/tenant-administrator-store.js'
import { createUserDeactivation } from './security/user-deactivation.js'
import { createUserDeletion } from './security/user-deletion.js'
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
let layout: ReturnType<typeof testDataLayout>
let options: ServerModeAppOptions

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'wb-server-mode-mcp-membership-'))
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
    serverDeps: resolveServerDeps(createContainer(storeMemoryModule)),
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

      // By its id, which names it in any namespace, a create is an ordinary
      // write to somebody else's workspace.
      const id = created.structuredContent?.workspaceId
      expect(id).toMatch(/^[0-9A-Z]{26}$/)
      const again = await eve.call('wb_workspace_edit', { ...createPlans, workspaceId: id })
      expect(again.isError).toBe(true)
      expect(textOf(again)).toMatch(/not_a_member/)
    } finally {
      await ada.close()
      await eve.close()
    }
  })
})

// ADR-0053: a bare segment means the caller's own namespace, so whether some
// other person holds it is never the answer to a create.
describe("server mode /mcp — a segment is the caller's own", () => {
  it("mints the agent's own workspace under a segment another person holds", async () => {
    const ada = await agentOf('ada')
    const eve = await agentOf('eve')
    try {
      expect((await ada.call('wb_workspace_edit', createPlans)).isError).toBeFalsy()

      const eves = await eve.call('wb_workspace_edit', {
        ...createPlans,
        ops: [{ op: 'document.create', path: 'mine', kind: 'markdown', markdown: 'eve' }],
      })
      expect(eves.isError, textOf(eves)).toBeFalsy()

      const paths = async (agent: typeof ada) => {
        const listed = await agent.call('wb_document_list', { workspaceId: 'plans' })
        expect(listed.isError, textOf(listed)).toBeFalsy()
        const documents = (listed.structuredContent?.documents ?? []) as { path: string }[]
        return documents.map((d) => d.path)
      }
      expect(await paths(ada)).toEqual(['notes'])
      expect(await paths(eve)).toEqual(['mine'])
    } finally {
      await ada.close()
      await eve.close()
    }
  })

  it('refuses a read of a segment only another person holds as it refuses one nobody holds', async () => {
    const ada = await agentOf('ada')
    const eve = await agentOf('eve')
    try {
      expect((await ada.call('wb_workspace_edit', createPlans)).isError).toBeFalsy()

      const held = await eve.call('wb_document_list', { workspaceId: 'plans' })
      const absent = await eve.call('wb_document_list', { workspaceId: 'nothing' })

      expect(held.isError).toBe(true)
      expect(textOf(held)).toBe(textOf(absent).replace('nothing', 'plans'))
    } finally {
      await ada.close()
      await eve.close()
    }
  })
})

describe('server mode /mcp — a tool needs the scope its /api twin needs', () => {
  it('refuses a delete to a read-scoped token and still answers its reads', async () => {
    const owner = await agentOf('ada')
    const reader = await agentOf('ada', 'canvas:read mcp:call')
    try {
      const created = await owner.call('wb_workspace_edit', createPlans)
      expect(created.isError, textOf(created)).toBeFalsy()
      const { results } = created.structuredContent as { results: Array<{ documentId: string }> }
      const documentId = results[0]?.documentId

      const deleted = await reader.call('wb_workspace_edit', {
        workspaceId: 'plans',
        ops: [{ op: 'document.delete', documentId }],
      })
      expect(deleted.isError).toBe(true)
      expect(textOf(deleted)).toMatch(/insufficient_scope/)

      const read = await reader.call('wb_document_get', {
        workspaceId: 'plans',
        documentIds: [documentId],
      })
      expect(read.isError, textOf(read)).toBeFalsy()
      expect(read.structuredContent?.documents).toEqual([
        expect.objectContaining({ documentId, content: expect.stringContaining('hello') }),
      ])
    } finally {
      await owner.close()
      await reader.close()
    }
  })
})

// A member can make a read fail as corrupt (an empty stored file, a read
// racing a purge); the answer must not hand them where this server keeps its
// data. The operator reads the detail in the log.
describe('server mode — a corrupt stored file is refused without its storage path', () => {
  it('answers corrupt_stored_data with no path and no data directory in the body', async () => {
    const ada = await agentOf('ada')
    try {
      const created = await ada.call('wb_workspace_edit', createPlans)
      expect(created.isError, textOf(created)).toBeFalsy()
      const { workspaceId } = created.structuredContent as { workspaceId: string }
      const dir = layout.workspaceFilesDir(workspaceId)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'empty1.png'), new Uint8Array(0))

      const res = await app.request(
        `${PUBLIC_URL}/api/w/${workspaceId}/document/notes/file/empty1`,
        {
          headers: { Authorization: `Bearer ${await tokenFor('ada', 'files:read')}` },
        },
      )
      const text = await res.text()
      expect(res.status, text).toBe(500)
      expect(JSON.parse(text)).toMatchObject({ error: 'corrupt_stored_data' })
      expect(text).not.toContain(tempDir)
      expect(text).not.toContain('/')
    } finally {
      await ada.close()
    }
  })
})

// Server mode answers a fault with a fixed internal-error text, so a refusal
// the member could act on reaches them only when it is a named error class.
describe('server mode /mcp — a refusal reaches the member in its own words', () => {
  it('answers an unknown render style and a move with nothing to do verbatim', async () => {
    const ada = await agentOf('ada')
    try {
      const created = await ada.call('wb_workspace_edit', createPlans)
      expect(created.isError, textOf(created)).toBeFalsy()
      const { results } = created.structuredContent as { results: Array<{ documentId: string }> }
      const documentId = results[0]?.documentId

      const rendered = await ada.call('wb_scene_render', {
        workspaceId: 'plans',
        documentId,
        style: 'visual.nope',
      })
      expect(rendered.isError).toBe(true)
      expect(textOf(rendered)).toMatch(/no theme "visual\.nope" is registered/)

      const moved = await ada.call('wb_workspace_edit', {
        workspaceId: 'plans',
        ops: [{ op: 'document.move', documentId }],
      })
      expect(moved.isError).toBe(true)
      expect(textOf(moved)).toMatch(/a move needs a `path` to move it, a `name` to rename it/)
    } finally {
      await ada.close()
    }
  })
})

// Where the server keeps a member's export is the operator's layout, not the
// member's: the answer names the file within the workspace's exports.
describe('server mode — an export answers no server path', () => {
  // The export renders from the directory the deps were booted over, so the
  // document has to be in it rather than in the in-memory index.
  beforeEach(async () => {
    const boot = await bootSelfHostDeps(tempDir)
    app = createApp({ ...options, serverDeps: boot.serverDeps, dataLayout: boot.dataLayout })
  })

  it.each([
    'export',
    'export-svg',
  ])('POST …/%s names the file without the data directory', async (action) => {
    const ada = await agentOf('ada')
    try {
      const created = await ada.call('wb_workspace_edit', {
        workspaceId: 'plans',
        createWorkspace: true,
        ops: [{ op: 'document.create', path: 'board', kind: 'spatial' }],
      })
      expect(created.isError, textOf(created)).toBeFalsy()
      const { workspaceId } = created.structuredContent as { workspaceId: string }

      const res = await app.request(`${PUBLIC_URL}/api/w/${workspaceId}/document/board/${action}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await tokenFor('ada', 'canvas:write canvas:read')}`,
          'content-type': 'application/json',
          origin: PUBLIC_URL,
        },
        body: '{}',
      })
      const text = await res.text()
      expect(res.status, text).toBe(200)
      expect(text).not.toContain(tempDir)
      const { filePath } = JSON.parse(text) as { filePath: string }
      expect(filePath).not.toMatch(/^\//)
      expect(filePath).toMatch(new RegExp(`^board-.*\\.${action === 'export' ? 'png' : 'svg'}$`))
    } finally {
      await ada.close()
    }
  })
})
