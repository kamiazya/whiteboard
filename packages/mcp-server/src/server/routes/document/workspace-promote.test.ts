/**
 * The promote route (ADR-0039): the same merge as workspace-document/update,
 * verified against the credential the origin pinned BEFORE anything lands,
 * and one explicit human checkpoint per promoted document carrying the
 * assertion. Every assertion here is built from a fresh P-256 key against
 * the challenge the route recomputes, so a refusal is the route's and never
 * the fixture's.
 */
import { createHash, sign as cryptoSign, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  promoteWorkspaceResponseSchema,
  promotionChallengeInput,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/promotion'
import { createWorkspaceDocumentAtPath } from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { seedWorkspaceRow } from '../_test-helpers.js'

let tempDir: string
vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { createDocumentRouter } = await import('../document.js')
const { clearCache } = await import('../../store/doc-cache.js')
const { _clearWorkspaceDocCacheForTests } = await import('../../store/document-store.js')
const { createIsolatedDb } = await import('../../store/db/test-helpers.js')
const { FileVersionStore } = await import('../../store/version-store.js')
const { createWebAuthnCredentialStore } = await import(
  '../../security/webauthn-credential-store.js'
)

let handle: Awaited<ReturnType<typeof createIsolatedDb>>
beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'promote-route-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  clearCache()
  _clearWorkspaceDocCacheForTests()
  await seedWorkspaceRow(tempDir, 'session1')
})
afterEach(async () => {
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

const HOSTED = 'https://latest.kamiazya-whiteboard.pages.dev'
const RP_ID = new URL(HOSTED).hostname
const ROADMAP_ID = '01BRWAAAAAAAAAAAAAAAAAAAA0'
const SKETCH_ID = '01BRWAAAAAAAAAAAAAAAAAAAA1'
const UP = 0x01
const UV = 0x04
const BE = 0x08

const sha256 = (input: Uint8Array | string): Buffer => createHash('sha256').update(input).digest()
const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')
const flipLastByte = (encoded: string): string => {
  const bytes = Buffer.from(encoded, 'base64url')
  bytes[bytes.length - 1] ^= 0xff
  return b64u(bytes)
}

function browserSnapshot(): Uint8Array {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, {
    path: 'notes/roadmap',
    documentId: ROADMAP_ID,
    kind: 'markdown',
    name: 'Roadmap',
  })
  createWorkspaceDocumentAtPath(doc, { path: 'sketch', documentId: SKETCH_ID, kind: 'spatial' })
  doc.commit()
  return new Uint8Array(doc.export({ mode: 'snapshot' }))
}

interface Passkey {
  privateKey: KeyObject
  credentialId: string
  publicKeyJwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string }
}

function passkey(id = 'credential-0123456789'): Passkey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
  return {
    privateKey,
    credentialId: b64u(Buffer.from(id)),
    publicKeyJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
  }
}

/** The assertion a browser would produce for THIS snapshot into THIS handle. */
function attest(
  key: Passkey,
  snapshot: Uint8Array,
  { workspaceId = 'session1', flags = UP | UV | BE, signCount = 0, origin = HOSTED } = {},
) {
  const challenge = sha256(
    promotionChallengeInput({ workspaceId, snapshotDigest: b64u(sha256(snapshot)) }),
  )
  const authenticatorData = Buffer.alloc(37)
  sha256(RP_ID).copy(authenticatorData, 0)
  authenticatorData[32] = flags
  authenticatorData.writeUInt32BE(signCount, 33)
  const clientDataJSON = Buffer.from(
    JSON.stringify({
      type: 'webauthn.get',
      challenge: b64u(challenge),
      origin,
      crossOrigin: false,
    }),
  )
  const signature = cryptoSign(
    'sha256',
    Buffer.concat([authenticatorData, sha256(clientDataJSON)]),
    key.privateKey,
  )
  return {
    kind: 'webauthn' as const,
    credentialId: key.credentialId,
    authenticatorData: b64u(authenticatorData),
    clientDataJSON: b64u(clientDataJSON),
    signature: b64u(signature),
  }
}

function harness() {
  const credentials = createWebAuthnCredentialStore(tempDir)
  const app = createDocumentRouter({ autoVersionQuietMs: 60_000, credentials })
  const key = passkey()
  credentials.register({
    origin: HOSTED,
    rpId: RP_ID,
    credentialId: key.credentialId,
    publicKeyJwk: key.publicKeyJwk,
    backupEligible: true,
    signCount: 0,
  })
  const promote = (body: unknown, headers: Record<string, string> = { Origin: HOSTED }) =>
    app.request('/api/w/session1/workspace-document/promote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  const documents = async () => {
    const res = await app.request('/api/workspaces/session1/documents')
    expect(res.status).toBe(200)
    return ((await res.json()) as { documents: { id: string }[] }).documents
  }
  return { app, credentials, key, promote, documents }
}

it('a verified attestation merges the record and leaves one explicit human checkpoint per document, carrying it', async () => {
  const { key, promote, documents } = harness()
  const snapshot = browserSnapshot()
  const attestation = attest(key, snapshot, { signCount: 3 })

  const res = await promote({ snapshot: b64u(snapshot), attestation })
  expect(res.status).toBe(200)
  const body = promoteWorkspaceResponseSchema.parse(await res.json())
  expect(body.attested).toBe(true)
  expect([...body.recorded].sort()).toEqual([ROADMAP_ID, SKETCH_ID])
  expect(body.shadowed).toEqual([])
  expect((await documents()).map((d) => d.id).sort()).toEqual([ROADMAP_ID, SKETCH_ID])

  const store = new FileVersionStore()
  for (const path of ['notes/roadmap', 'sketch']) {
    const versions = await store.list('session1', path)
    expect(versions).toHaveLength(1)
    expect(versions[0]).toMatchObject({ auto: false, operator: { kind: 'human' }, attestation })
  }
})

it('without an attestation the merge and the rows still land, and the rows carry no evidence', async () => {
  const { promote, documents } = harness()
  const snapshot = browserSnapshot()
  const res = await promote({ snapshot: b64u(snapshot) })
  expect(res.status).toBe(200)
  expect(promoteWorkspaceResponseSchema.parse(await res.json()).attested).toBe(false)
  expect(await documents()).toHaveLength(2)
  const versions = await new FileVersionStore().list('session1', 'sketch')
  expect(versions).toHaveLength(1)
  expect(versions[0]?.auto).toBe(false)
  expect(versions[0]?.operator?.kind).toBe('human')
  expect(versions[0]?.attestation).toBeUndefined()
})

it('a refused attestation merges nothing and writes nothing, and says why', async () => {
  const { key, promote, documents, credentials } = harness()
  const snapshot = browserSnapshot()
  const good = attest(key, snapshot, { signCount: 1 })

  const cases: { attestation: unknown; headers?: Record<string, string>; reason: string }[] = [
    // A flipped signature byte — flipped in the DECODED bytes, because
    // rewriting the last base64url characters can land on the same bytes
    // (an ECDSA signature is random per run and can already end in those
    // characters), which is a mutation that mutates nothing.
    {
      attestation: { ...good, signature: flipLastByte(good.signature) },
      reason: 'signature',
    },
    // Signed for another workspace: the challenge binds the target handle.
    { attestation: attest(key, snapshot, { workspaceId: 'session2' }), reason: 'challenge' },
    // Signed over other bytes than the ones sent.
    { attestation: attest(key, new Uint8Array([9, 9, 9])), reason: 'challenge' },
    // A credential this origin never pinned.
    {
      attestation: attest(passkey('never-pinned-credential'), snapshot),
      reason: 'unknownCredential',
    },
    // The gesture skipped user verification.
    { attestation: attest(key, snapshot, { flags: UP | BE }), reason: 'userVerification' },
    // BE is fixed for a credential's life; this pin said eligible.
    { attestation: attest(key, snapshot, { flags: UP | UV }), reason: 'backupEligibility' },
    // No Origin header: the pin cannot be looked up, whatever the body says.
    { attestation: good, headers: {}, reason: 'origin' },
  ]
  for (const { attestation, headers, reason } of cases) {
    const res = await promote({ snapshot: b64u(snapshot), attestation }, headers)
    expect(res.status, reason).toBe(403)
    expect(await res.json()).toEqual({ error: 'attestation_rejected', message: reason })
  }
  expect(await documents()).toEqual([])
  expect(await new FileVersionStore().list('session1', 'sketch')).toEqual([])
  // Nothing above advanced the count either.
  expect(credentials.find(HOSTED, key.credentialId)?.signCount).toBe(0)
})

it('a sign count that does not advance is refused, so a counted assertion cannot be replayed', async () => {
  const { key, promote, credentials } = harness()
  const snapshot = browserSnapshot()
  const attestation = attest(key, snapshot, { signCount: 5 })
  expect((await promote({ snapshot: b64u(snapshot), attestation })).status).toBe(200)
  expect(credentials.find(HOSTED, key.credentialId)?.signCount).toBe(5)

  const replay = await promote({ snapshot: b64u(snapshot), attestation })
  expect(replay.status).toBe(403)
  expect(await replay.json()).toEqual({ error: 'attestation_rejected', message: 'signCount' })
  // The merge is idempotent, so what the replay would have added is rows only.
  expect(await new FileVersionStore().list('session1', 'sketch')).toHaveLength(1)
})

it('refuses a body that is not the contract, and bytes that are not a record', async () => {
  const { promote } = harness()
  expect((await promote({ snapshot: 'not base64url!' })).status).toBe(400)
  expect((await promote({ snapshot: b64u(browserSnapshot()), extra: 1 })).status).toBe(400)
  const notLoro = await promote({ snapshot: b64u(new Uint8Array([1, 2, 3, 4])) })
  expect(notLoro.status).toBe(400)
  expect(await new FileVersionStore().list('session1', 'sketch')).toEqual([])
})

it('answers 404 for a workspace the daemon never registered', async () => {
  const { app } = harness()
  const res = await app.request('/api/w/unregistered/workspace-document/promote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: HOSTED },
    body: JSON.stringify({ snapshot: b64u(browserSnapshot()) }),
  })
  expect(res.status).toBe(404)
})
