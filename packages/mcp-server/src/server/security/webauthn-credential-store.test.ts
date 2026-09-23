import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tenantRoot } from '../tenant/data-layout.js'
import { SELF_HOST_TENANT_ID } from '../tenant/id.js'
import { createWebAuthnCredentialStore } from './webauthn-credential-store.js'

let dir: string | null = null
function tempDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'webauthn-credentials-'))
  return dir
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

const HOSTED = 'https://latest.kamiazya-whiteboard.pages.dev'
const JWK = { kty: 'EC' as const, crv: 'P-256' as const, x: 'eA', y: 'eQ' }

function registration(
  overrides: Partial<
    Parameters<ReturnType<typeof createWebAuthnCredentialStore>['register']>[0]
  > = {},
) {
  return {
    origin: HOSTED,
    rpId: 'latest.kamiazya-whiteboard.pages.dev',
    credentialId: 'Y3JlZC0x',
    publicKeyJwk: JWK,
    backupEligible: true,
    signCount: 0,
    ...overrides,
  }
}

describe('webauthn credential store', () => {
  it('persists a registration and finds it by origin and credential id', () => {
    const store = createWebAuthnCredentialStore(tenantRoot(tempDir(), SELF_HOST_TENANT_ID))
    const pinned = store.register(registration())
    expect(pinned.credentialId).toBe('Y3JlZC0x')
    expect(pinned.backupEligible).toBe(true)
    expect(pinned.createdAt).toMatch(/^\d{4}-/)

    const reloaded = createWebAuthnCredentialStore(tenantRoot(dir as string, SELF_HOST_TENANT_ID))
    expect(reloaded.find(HOSTED, 'Y3JlZC0x')).toEqual(pinned)
    // Scoped to the origin: the same id from another origin is another credential.
    expect(reloaded.find('https://other.example', 'Y3JlZC0x')).toBeNull()
    expect(reloaded.find(HOSTED, 'missing')).toBeNull()
  })

  it('a second registration of the same credential replaces the pin rather than doubling it', () => {
    const store = createWebAuthnCredentialStore(tenantRoot(tempDir(), SELF_HOST_TENANT_ID))
    store.register(registration({ signCount: 4 }))
    store.register(registration({ signCount: 9 }))
    expect(store.list()).toHaveLength(1)
    expect(store.find(HOSTED, 'Y3JlZC0x')?.signCount).toBe(9)
  })

  it('records a higher sign count and refuses a lower or equal one that is not zero', () => {
    const store = createWebAuthnCredentialStore(tenantRoot(tempDir(), SELF_HOST_TENANT_ID))
    store.register(registration({ signCount: 5 }))
    expect(store.recordSignCount(HOSTED, 'Y3JlZC0x', 6)).toBe(true)
    expect(store.find(HOSTED, 'Y3JlZC0x')?.signCount).toBe(6)
    // Not monotonic: a cloned authenticator, or a replay. Not recorded.
    expect(store.recordSignCount(HOSTED, 'Y3JlZC0x', 6)).toBe(false)
    expect(store.recordSignCount(HOSTED, 'Y3JlZC0x', 2)).toBe(false)
    expect(store.find(HOSTED, 'Y3JlZC0x')?.signCount).toBe(6)
    // An authenticator that never counts (synced passkeys report 0) is
    // accepted every time; the spec says the check is only meaningful when
    // either side is non-zero.
    const noCount = createWebAuthnCredentialStore(tenantRoot(dir as string, SELF_HOST_TENANT_ID))
    noCount.register(registration({ credentialId: 'bm8tY291bnQ', signCount: 0 }))
    expect(noCount.recordSignCount(HOSTED, 'bm8tY291bnQ', 0)).toBe(true)
    expect(noCount.recordSignCount(HOSTED, 'unknown', 1)).toBe(false)
  })

  it('does not answer one tenant with a passkey another tenant pinned', () => {
    const dirPath = tempDir()
    const mine = createWebAuthnCredentialStore(tenantRoot(dirPath, SELF_HOST_TENANT_ID))
    mine.register(registration())
    const theirs = createWebAuthnCredentialStore(tenantRoot(dirPath, 'tenant-two'))
    expect(theirs.find(HOSTED, 'Y3JlZC0x')).toBeNull()
    expect(mine.find(HOSTED, 'Y3JlZC0x')).not.toBeNull()
  })

  it('revoke removes the pin', () => {
    const store = createWebAuthnCredentialStore(tenantRoot(tempDir(), SELF_HOST_TENANT_ID))
    store.register(registration())
    expect(store.revoke(HOSTED, 'Y3JlZC0x')).toBe(true)
    expect(store.find(HOSTED, 'Y3JlZC0x')).toBeNull()
    expect(store.revoke(HOSTED, 'Y3JlZC0x')).toBe(false)
    expect(
      createWebAuthnCredentialStore(tenantRoot(dir as string, SELF_HOST_TENANT_ID)).list(),
    ).toEqual([])
  })

  it('a corrupt file starts empty instead of failing the daemon, and is written owner-only', () => {
    const d = tempDir()
    mkdirSync(tenantRoot(d, SELF_HOST_TENANT_ID), { recursive: true })
    writeFileSync(
      join(tenantRoot(d, SELF_HOST_TENANT_ID), 'webauthn-credentials.json'),
      '{"version":1,"credentials":"nope"}',
    )
    const store = createWebAuthnCredentialStore(tenantRoot(d, SELF_HOST_TENANT_ID))
    expect(store.list()).toEqual([])
    store.register(registration())
    const raw = JSON.parse(
      readFileSync(join(tenantRoot(d, SELF_HOST_TENANT_ID), 'webauthn-credentials.json'), 'utf8'),
    ) as {
      credentials: unknown[]
    }
    expect(raw.credentials).toHaveLength(1)
  })
})
