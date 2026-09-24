/**
 * The operator creates a user ahead of their first sign-in, naming them by a
 * declared provider and the subject that provider knows them by. It is what
 * keeps a bearer-only provider invitation-only: without it, the only way in is
 * `createAccounts: true`.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createMemberProfileStore,
  type MemberProfileStore,
} from '../server/security/member-profile-store.js'
import { providerAuthenticator } from '../server/security/sign-in-config.js'
import { createIsolatedDb } from '../server/store/db/test-helpers.js'
import { runServerAddUser } from './server-add-user.js'

const ISSUER = 'https://sso.corp.example'

let root: string
let configPath: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let members: MemberProfileStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-add-user-'))
  handle = await createIsolatedDb({ dataDir: root })
  members = createMemberProfileStore(handle.db)
  configPath = join(root, 'sign-in.json')
  // A client secret that is NOT in the environment: this command reads the
  // providers' identities, never their secrets.
  await writeFile(
    configPath,
    JSON.stringify({
      providers: [
        {
          id: 'corp-mcp',
          kind: 'oidc',
          issuer: ISSUER,
          admission: { bearerClients: ['claude-code'] },
        },
        {
          id: 'google',
          kind: 'oidc',
          issuer: 'https://accounts.google.com',
          clientId: 'wb',
          clientSecret: { env: 'NOT_SET_HERE' },
        },
      ],
    }),
  )
})
afterEach(async () => {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

function run(args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  const out: string[] = []
  const err: string[] = []
  const io = { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) }
  const withConfig = { WHITEBOARD_SIGN_IN_CONFIG: configPath, ...env }
  return runServerAddUser([...args, `--data-dir=${root}`], io, withConfig).then((code) => ({
    code,
    stdout: out.join(''),
    stderr: err.join(''),
  }))
}

const binding = { authenticator: providerAuthenticator({ issuer: ISSUER }), subject: 'ada-1' }

describe('whiteboard server add-user', () => {
  it("creates the user a bearer for that provider's subject will resolve to", async () => {
    const res = await run(['--json', '--provider=corp-mcp', '--subject=ada-1', '--name=Ada'])
    expect(res.code).toBe(0)
    const user = await members.profileForBinding(binding)
    expect(user?.displayName).toBe('Ada')
    expect(JSON.parse(res.stdout)).toEqual({
      kind: 'ok',
      created: true,
      user: { id: user?.id, displayName: 'Ada' },
    })
  })

  it('answers the existing user when the person already has one', async () => {
    const existing = await members.ensureProfile({ binding, displayName: 'Ada L.' })
    const res = await run(['--json', '--provider=corp-mcp', '--subject=ada-1', '--name=Ada'])
    expect(res.code).toBe(0)
    expect(JSON.parse(res.stdout)).toEqual({
      kind: 'ok',
      created: false,
      user: { id: existing.id, displayName: 'Ada L.' },
    })
  })

  it('names the subject when no display name is given', async () => {
    await run(['--json', '--provider=corp-mcp', '--subject=ada-1'])
    expect((await members.profileForBinding(binding))?.displayName).toBe('ada-1')
  })

  it('refuses a provider the configuration does not declare, listing those it does', async () => {
    const res = await run(['--json', '--provider=nobody', '--subject=ada-1'])
    expect(res.code).toBe(1)
    expect(JSON.parse(res.stdout)).toEqual({
      kind: 'unknown-provider',
      providers: ['corp-mcp', 'google'],
    })
    expect(await members.listUsers()).toEqual([])
  })

  it('refuses without a sign-in configuration, naming the variable', async () => {
    const res = await run(['--json', '--provider=corp-mcp', '--subject=ada-1'], {
      WHITEBOARD_SIGN_IN_CONFIG: '',
    })
    expect(res.code).toBe(1)
    expect(res.stderr).toContain('WHITEBOARD_SIGN_IN_CONFIG')
  })

  it('exits 64 without --subject', async () => {
    const res = await run(['--json', '--provider=corp-mcp'])
    expect(res.code).toBe(64)
    expect(res.stderr).toContain('--subject=<sub> is required')
  })
})
