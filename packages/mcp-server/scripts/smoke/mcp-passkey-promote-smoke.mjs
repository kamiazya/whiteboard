#!/usr/bin/env node
// Real-browser proof of ADR-0039's promote attestation across the process
// boundary: a REAL Chromium authenticator (CDP virtual authenticator, CTAP2,
// internal transport, user verification) on a hosted-style origin, against
// this daemon's real verifier, through the same fetches the web app makes —
// the pairing bearer under the browser-enforced Origin header.
//
// Why this exists beside the browser-mode tests: those drive the UI with a
// fake authenticator and a fetch stub, and the route tests drive the verifier
// with hand-built authenticatorData. Neither sees what the other produces.
// The one thing that found a real defect here (Chromium's clientDataJSON
// carrying `other_keys_can_be_added_here`, which a strict schema refuses)
// was visible only to bytes a browser actually made.
//
// What this pins, in the order a person would meet it:
// 1. A paired origin registers a passkey: `getPublicKey()` SPKI and the
//    registration authenticatorData are accepted by POST /api/pairing/credentials.
// 2. An assertion over the challenge the daemon recomputes promotes the
//    record: 200, `attested: true`.
// 3. Refusals: a tampered signature, the same assertion against another
//    workspace, and a replay each answer 403 with the verifier's reason — and
//    none of them lands anything.
// 4. A fresh assertion for the same bytes is accepted again (the merge is
//    idempotent; only the assertion is single-use).
// 5. The History row carries the evidence: a human, `auto: false` version
//    with the attestation beside it.
//
// Direct invocation requires tsx:
//   node --import tsx/esm scripts/smoke/mcp-passkey-promote-smoke.mjs
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promotionChallengeInput } from '@kamiazya/whiteboard-daemon-client/api-contracts/promotion'
import { createWorkspaceDocumentAtPath } from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { chromium } from 'playwright'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '../..')

// `server/config.ts`'s DATA_DIR is a module-level constant captured from
// WHITEBOARD_DATA_DIR at import time — it MUST be set before the dynamic
// import below.
const dataDir = mkdtempSync(join(tmpdir(), 'whiteboard-passkey-promote-smoke-'))
process.env.WHITEBOARD_DATA_DIR = dataDir
const { startHttpServer } = await import(resolve(root, 'src/server/http-server.ts'))
const { findAvailablePort } = await import(resolve(root, 'src/cli/daemon-run.ts'))

const TAG = '[mcp-passkey-promote-smoke]'
const TOKEN = 'smoke-passkey-promote-daemon-token'
const DOCUMENT_ID = '01BRWAAAAAAAAAAAAAAAAAAAA0'
const DOCUMENT_PATH = 'moved-note'
const UV = 0x04

const sha256 = (input) => createHash('sha256').update(input).digest()
const b64u = (bytes) => Buffer.from(bytes).toString('base64url')

let failed = false
const pass = (msg) => console.log(`  pass  ${msg}`)
const fail = (msg) => {
  console.error(`  FAIL  ${msg}`)
  failed = true
}
const check = (ok, msg, detail) => (ok ? pass(msg) : fail(detail ? `${msg} — ${detail}` : msg))

// The record a browser keeper would move: the same shape the route test
// builds, so a refusal is the seam's and never the fixture's.
function browserSnapshot() {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, {
    path: DOCUMENT_PATH,
    documentId: DOCUMENT_ID,
    kind: 'markdown',
    name: 'Moved note',
  })
  doc.commit()
  return new Uint8Array(doc.export({ mode: 'snapshot' }))
}

// A hosted-style page origin. `localhost` rather than 127.0.0.1 because an
// rpId must be a domain, and this is the one loopback name WebAuthn accepts.
const hosted = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end('<!doctype html><title>hosted</title><p>hosted origin</p>')
})
await new Promise((r) => hosted.listen(0, '127.0.0.1', r))
const HOSTED = `http://localhost:${hosted.address().port}`

const port = await findAvailablePort(4300)
const running = await startHttpServer({ port, host: '127.0.0.1', token: TOKEN })
const daemonBaseUrl = `http://127.0.0.1:${port}`

// Operator-side calls (what /pair's consent and a settings page do), under
// the daemon token from the daemon's own origin.
const operator = async (path, init = {}) => {
  const res = await fetch(`${daemonBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Origin: daemonBaseUrl,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: res.status, body }
}

const browser = await chromium.launch({
  headless: true,
  ...(process.env.WHITEBOARD_CHROME_PATH && {
    executablePath: process.env.WHITEBOARD_CHROME_PATH,
  }),
})
const consoleErrors = []

try {
  // --- setup: the origin is paired, and the daemon holds a target ---
  const grant = await operator('/api/pairing/grants', {
    method: 'POST',
    body: JSON.stringify({ origin: HOSTED, codeChallenge: 'smoke-challenge' }),
  })
  check(grant.status === 201, 'the hosted origin holds a pairing grant', `got ${grant.status}`)

  const target = await operator('/api/workspaces', {
    method: 'POST',
    body: JSON.stringify({ displayName: 'target' }),
  })
  const other = await operator('/api/workspaces', {
    method: 'POST',
    body: JSON.stringify({ displayName: 'other' }),
  })
  const targetId = target.body?.workspaceId
  const otherId = other.body?.workspaceId
  check(
    typeof targetId === 'string' && typeof otherId === 'string',
    'two daemon workspaces exist to promote into',
    JSON.stringify({ target: target.status, other: other.status }),
  )

  const snapshot = browserSnapshot()

  // --- the browser: a real authenticator on the paired origin ---
  const context = await browser.newContext()
  const page = await context.newPage()
  page.on('console', (msg) => {
    // The refusals below are asked for, and Chromium logs each 403 as a
    // resource error; only anything else is worth a reader's attention.
    if (msg.type() === 'error' && !/status of 403/.test(msg.text())) consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => consoleErrors.push(`uncaught: ${err.message}`))
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  await page.goto(HOSTED, { waitUntil: 'load' })

  // Everything below runs IN THE PAGE: the pairing bearer travels with the
  // Origin header the browser adds, which is the only way the daemon honours
  // it — the same path apps/web's createDaemonFetch takes.
  const session = await page.evaluate(async (daemon) => {
    const res = await fetch(`${daemon}/api/pairing/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grantType: 'origin' }),
    })
    return { status: res.status, body: await res.json() }
  }, daemonBaseUrl)
  check(
    session.status === 200 && typeof session.body?.token === 'string',
    'the paired origin mints a pairing session token from the page',
    `got ${session.status}`,
  )
  const bearer = session.body.token

  const registration = await page.evaluate(
    async ({ daemon, bearer }) => {
      const b64u = (b) =>
        btoa(String.fromCharCode(...new Uint8Array(b)))
          .replaceAll('+', '-')
          .replaceAll('/', '_')
          .replaceAll('=', '')
      // The exact options apps/web's registerPasskey sends.
      const cred = await navigator.credentials.create({
        publicKey: {
          rp: { name: 'Whiteboard' },
          user: {
            id: crypto.getRandomValues(new Uint8Array(16)),
            name: 'whiteboard',
            displayName: 'whiteboard',
          },
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
          attestation: 'none',
        },
      })
      const response = cred.response
      if (typeof response.getPublicKey !== 'function') return { status: 0, body: 'no getPublicKey' }
      const credentialId = b64u(cred.rawId)
      const res = await fetch(`${daemon}/api/pairing/credentials`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          credentialId,
          publicKey: b64u(response.getPublicKey()),
          authenticatorData: b64u(response.getAuthenticatorData()),
        }),
      })
      return { status: res.status, body: await res.json(), credentialId }
    },
    { daemon: daemonBaseUrl, bearer },
  )
  check(
    registration.status === 201 && registration.body?.credentialId === registration.credentialId,
    'the browser registers a passkey and the daemon pins it (201)',
    JSON.stringify(registration),
  )
  check(
    registration.body?.backupEligible === false,
    'a device-bound virtual authenticator pins as not backup-eligible',
    JSON.stringify(registration.body),
  )

  // The assertion over the challenge the daemon recomputes — the same shared
  // input apps/web hashes — and the promote POST, both from the page.
  const challengeFor = (workspaceId) => [
    ...sha256(promotionChallengeInput({ workspaceId, snapshotDigest: b64u(sha256(snapshot)) })),
  ]
  const assertion = (workspaceId) =>
    page.evaluate(
      async ({ challenge, credentialId }) => {
        const b64u = (b) =>
          btoa(String.fromCharCode(...new Uint8Array(b)))
            .replaceAll('+', '-')
            .replaceAll('/', '_')
            .replaceAll('=', '')
        const fromB64u = (v) => {
          const p = v.replaceAll('-', '+').replaceAll('_', '/')
          return Uint8Array.from(atob(p.padEnd(Math.ceil(p.length / 4) * 4, '=')), (c) =>
            c.charCodeAt(0),
          )
        }
        const cred = await navigator.credentials.get({
          publicKey: {
            challenge: Uint8Array.from(challenge),
            allowCredentials: [{ type: 'public-key', id: fromB64u(credentialId) }],
            userVerification: 'required',
          },
        })
        const r = cred.response
        return {
          kind: 'webauthn',
          credentialId: b64u(cred.rawId),
          authenticatorData: b64u(r.authenticatorData),
          clientDataJSON: b64u(r.clientDataJSON),
          signature: b64u(r.signature),
        }
      },
      { challenge: challengeFor(workspaceId), credentialId: registration.credentialId },
    )
  const promote = (workspaceId, attestation) =>
    page.evaluate(
      async ({ daemon, bearer, workspaceId, body }) => {
        const res = await fetch(`${daemon}/api/w/${workspaceId}/workspace-document/promote`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        return { status: res.status, body: await res.json() }
      },
      {
        daemon: daemonBaseUrl,
        bearer,
        workspaceId,
        body: { snapshot: b64u(snapshot), attestation },
      },
    )

  const attestation = await assertion(targetId)
  const clientData = JSON.parse(Buffer.from(attestation.clientDataJSON, 'base64url').toString())
  check(
    clientData.type === 'webauthn.get' && clientData.origin === HOSTED,
    'the assertion names the paired origin in its clientDataJSON',
    JSON.stringify(clientData),
  )
  check(
    (Buffer.from(attestation.authenticatorData, 'base64url')[32] & UV) === UV,
    'the assertion carries user verification',
  )

  // --- refusals first, so nothing has landed when they are checked ---
  // Flip one byte in the middle of the DER signature and re-encode, so the
  // tamper stays canonical base64url and is refused by the VERIFIER rather
  // than by the body schema (a changed tail character can carry set padding
  // bits, which the schema refuses first).
  const signatureBytes = Buffer.from(attestation.signature, 'base64url')
  signatureBytes[Math.floor(signatureBytes.length / 2)] ^= 0x01
  const tampered = { ...attestation, signature: b64u(signatureBytes) }
  const refusedSignature = await promote(targetId, tampered)
  check(
    refusedSignature.status === 403 && refusedSignature.body?.message === 'signature',
    'a tampered signature is refused as `signature`',
    JSON.stringify(refusedSignature),
  )
  const refusedChallenge = await promote(otherId, attestation)
  check(
    refusedChallenge.status === 403 && refusedChallenge.body?.message === 'challenge',
    'the same assertion against another workspace is refused as `challenge`',
    JSON.stringify(refusedChallenge),
  )
  const untouched = await operator(`/api/workspaces/${targetId}/documents`)
  check(
    Array.isArray(untouched.body?.documents) && untouched.body.documents.length === 0,
    'a refused promote lands nothing',
    JSON.stringify(untouched.body),
  )

  // --- the move, its replay, and a fresh assertion ---
  const promoted = await promote(targetId, attestation)
  check(
    promoted.status === 200 &&
      promoted.body?.attested === true &&
      Array.isArray(promoted.body.recorded) &&
      promoted.body.recorded.includes(DOCUMENT_ID),
    'the assertion promotes the record: 200, attested, the document recorded',
    JSON.stringify(promoted),
  )
  const replayed = await promote(targetId, attestation)
  check(
    replayed.status === 403 && replayed.body?.message === 'signCount',
    'replaying the same assertion is refused as `signCount`',
    JSON.stringify(replayed),
  )
  const again = await promote(targetId, await assertion(targetId))
  check(
    again.status === 200 && again.body?.attested === true,
    'a fresh assertion for the same bytes is accepted again',
    JSON.stringify(again),
  )

  // --- the row carries the evidence ---
  const versions = await operator(`/api/workspaces/${targetId}/documents/${DOCUMENT_PATH}/versions`)
  const rows = Array.isArray(versions.body?.versions) ? versions.body.versions : []
  const attested = rows.filter((v) => v.attestation !== undefined)
  check(
    attested.length >= 1 && attested.every((v) => v.auto === false && v.operator?.kind === 'human'),
    'History holds a human, explicit version carrying the attestation',
    JSON.stringify(
      rows.map((v) => ({
        auto: v.auto,
        operator: v.operator?.kind,
        attested: v.attestation !== undefined,
      })),
    ),
  )
  check(
    attested.some((v) => v.attestation?.credentialId === registration.credentialId),
    'the recorded attestation names the credential the browser registered',
  )

  await context.close()
} catch (err) {
  fail(`unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
} finally {
  await browser.close()
  await running.close()
  hosted.close()
  rmSync(dataDir, { recursive: true, force: true })
}

if (consoleErrors.length > 0) {
  console.log(`  note  browser console errors observed:\n    ${consoleErrors.join('\n    ')}`)
}
if (failed) {
  console.error(`${TAG} FAIL`)
  process.exit(1)
}
console.log(`${TAG} PASS`)
