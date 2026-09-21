#!/usr/bin/env node
// Real-browser proof of the read plane end to end (ADR-0042 decisions 2-5,
// ADR-0043 decision 3): a REAL daemon, the REAL built web app served from
// its own origin, and a REAL Chromium virtual authenticator — sealing a
// replica in real IndexedDB, withholding it after a real membership
// removal, and the real page landing on the locked/unpaired states a cold
// load and a revoked grant produce.
//
// Why this exists beside the browser-mode tests: every one of them fakes
// the daemon at `fetch`, and every route test fakes the browser. Nothing
// before this watched the composed system — a real 403 from the real
// membership store, real ciphertext in real IndexedDB, a real cold-start
// key loss.
//
// The app is served from its OWN origin (a tiny node:http static server
// over `dist/web-app`), never from the daemon: the daemon serves only
// `/pair` and 302s every other UI path (mcp-daemon-origin-smoke.mjs). A
// WebAuthn rpId must be a domain, so that origin is `localhost`, matching
// the passkey-promote smoke's own hosted origin. One browser CONTEXT runs
// the whole scenario: every `page.goto` back to the same URL is a real
// cold reload (a fresh top-level navigation resets this build's in-memory
// session-key cache — `replica-session-key.ts`'s module singleton — the
// same way a real tab reload would), while localStorage and IndexedDB on
// that origin persist across it, exactly like a returning visit.
//
// What this pins, in the order a person meets it:
// 1. A paired origin + a registered passkey + a workspace membership pulls
//    a sealed replica: the IndexedDB dump and localStorage hold neither the
//    document's plaintext body nor the real workspace key bytes.
// 2. The daemon stopped, a cold reload: `replica-state-locked` (ADR-0042
//    decision 2 — the key lived in memory only, and a fresh page load never
//    held one).
// 3. The daemon restarted on the same port/data dir, Reconnect clicked: the
//    renewal pairs, and the replica page unmounts for the daemon page
//    (App.tsx only mounts ReplicaReadPage on a FAILED renewal).
// 4. The member removed while the daemon stays up, cold reload: the
//    renewal still pairs (member removal revokes SESSION tokens, not the
//    file-backed origin GRANT — routes/membership.ts), so the daemon page
//    mounts rather than ReplicaReadPage. What this check pins is ADR-0042
//    decision 4's real invariant — nothing is sent once the key is
//    withheld — against the real 403 `not_a_member` the replica-key route
//    now answers. It does NOT assert `replica-state-removed`: App only
//    mounts that page on a renewal refusal, and a member removal alone is
//    not one. That gap between the documented 'Removed' page
//    (docs/explanation/security-model.md) and what a member removal alone
//    can reach is filed as a whiteboard issue rather than patched here.
// 5. The origin grant revoked (member re-added first): `replica-state-
//    unpaired`, never `removed` — ADR-0042 decision 5's distinction
//    between a pairing refusal and a membership refusal.
// 6. Skipped: `no-offline` cannot render `replica-state-needs-connection`
//    in the composed app either, for the same reason as (4) — a daemon
//    that is UP always pairs the renewal and mounts the daemon page first.
//    The observable (a `replica_not_allowed` 403, no registry entry) is
//    already pinned by replica-key.test.ts.
//
// Direct invocation requires tsx:
//   node --import tsx/esm scripts/smoke/mcp-read-plane-smoke.mjs
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { chromium } from 'playwright'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolvePath(__dirname, '../..')
const webAppDir = resolvePath(root, 'dist/web-app')
const webAppIndexHtml = join(webAppDir, 'index.html')

if (!existsSync(webAppIndexHtml)) {
  console.error(
    `[mcp-read-plane-smoke] FAIL: ${webAppIndexHtml} not found — run \`pnpm build\` (from the repo root, so apps/web's postbuild copy runs) first`,
  )
  process.exit(1)
}

// `server/config.ts`'s DATA_DIR is a module-level constant captured from
// WHITEBOARD_DATA_DIR at import time — it MUST be set before the dynamic
// import below.
const dataDir = mkdtempSync(join(tmpdir(), 'whiteboard-read-plane-smoke-'))
process.env.WHITEBOARD_DATA_DIR = dataDir

const { startHttpServer } = await import(resolvePath(root, 'src/server/http-server.ts'))
const { findAvailablePort } = await import(resolvePath(root, 'src/cli/daemon-run.ts'))

const TAG = '[mcp-read-plane-smoke]'
const TOKEN = 'smoke-read-plane-daemon-token'
const DOCUMENT_ID = '01BRWAAAAAAAAAAAAAAAAAAAA1'
const DOCUMENT_PATH = 'moved-note'
const MARKER = 'read-plane-smoke-marker-body-text'
const PASSKEYS_KEY = 'whiteboard:daemon-passkeys'

let failed = false
const pass = (msg) => console.log(`  pass  ${msg}`)
const fail = (msg) => {
  console.error(`  FAIL  ${msg}`)
  failed = true
}
const check = (ok, msg, detail) => (ok ? pass(msg) : fail(detail ? `${msg} — ${detail}` : msg))

/** Stringifies a detail for a failure message, throwing if it would leak the
 *  daemon token or a minted pairing token — this smoke never prints either. */
function redact(value, ...secrets) {
  const s = typeof value === 'string' ? value : JSON.stringify(value)
  for (const secret of secrets) {
    if (secret && s.includes(secret)) throw new Error('smoke detail would have leaked a token')
  }
  if (s.includes(TOKEN)) throw new Error('smoke detail would have leaked the daemon token')
  return s
}

// The record a browser keeper would pull: the same shape mcp-passkey-promote-
// smoke.mjs builds, plus a real markdown body so the sealed-at-rest walk has
// a real plaintext marker to look for.
function seedSnapshot() {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, {
    path: DOCUMENT_PATH,
    documentId: DOCUMENT_ID,
    kind: 'markdown',
    name: 'Moved note',
  })
  writeMarkdownBody(documentContainers(doc, DOCUMENT_ID), MARKER)
  doc.commit()
  return new Uint8Array(doc.export({ mode: 'snapshot' }))
}

// A tiny SPA static server over the built app, on its own `localhost`
// origin — the daemon serves only /pair, so the app must come from
// somewhere else, the way a hosted deploy would.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '': 'application/octet-stream',
}
const staticServer = createServer(async (req, res) => {
  let urlPath = new URL(req.url ?? '/', 'http://localhost').pathname
  if (urlPath === '/' || !urlPath.includes('.')) urlPath = '/index.html'
  const filePath = join(webAppDir, urlPath)
  try {
    const body = await readFile(filePath)
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? MIME[''] })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
})
await new Promise((r) => staticServer.listen(0, '127.0.0.1', r))
const APP = `http://localhost:${staticServer.address().port}`

const port = await findAvailablePort(4300)
let running = await startHttpServer({
  port,
  host: '127.0.0.1',
  token: TOKEN,
  exitProcess: (code) => {
    throw new Error(`daemon exited fatally with code ${code}`)
  },
})
const daemonBaseUrl = `http://127.0.0.1:${port}`

/** Operator-side calls under the daemon token from the daemon's own origin —
 *  what /pair's consent and a settings page do. */
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

const grant = await operator('/api/pairing/grants', {
  method: 'POST',
  body: JSON.stringify({ origin: APP, codeChallenge: 'smoke-read-plane-challenge' }),
})
check(grant.status === 201, 'the app origin holds a pairing grant', redact(grant))
const grantId = grant.body?.grantId

// The daemon auto-creates one workspace at startup — reused here rather
// than minting a second one. A real Chromium with 2+ daemon workspaces
// paired hits an unrelated pre-existing defect (a runaway request storm —
// hundreds of req/s — in the workspace gallery's per-workspace summary
// fetch, reproducible with nothing more than a pairing and two workspaces,
// filed as a whiteboard issue rather than fixed in this read-plane lane).
const workspaceList = await operator('/api/workspaces')
const workspaceId = workspaceList.body?.workspaces?.[0]?.workspaceId
check(
  typeof workspaceId === 'string',
  'the daemon has its auto-created workspace to replicate',
  redact(workspaceList),
)

const snapshot = seedSnapshot()
const seedUpdate = await fetch(`${daemonBaseUrl}/api/w/${workspaceId}/workspace-document/update`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    Origin: daemonBaseUrl,
    'Content-Type': 'application/octet-stream',
  },
  body: snapshot,
})
check(
  seedUpdate.ok,
  'the workspace document is seeded with the marker body',
  `${seedUpdate.status}`,
)

const browser = await chromium.launch({
  headless: true,
  ...(process.env.WHITEBOARD_CHROME_PATH && {
    executablePath: process.env.WHITEBOARD_CHROME_PATH,
  }),
})

const consoleErrors = []
/** Every response this build got FROM the daemon, in arrival order — the
 *  request log every check below slices between marks. */
const daemonResponses = []
/** Real replica-key response bodies, keyed by their index in
 *  `daemonResponses` — kept OUT of that array so a failure message that
 *  stringifies a log slice can never print key bytes. */
const replicaKeyBodies = new Map()

try {
  const context = await browser.newContext()
  // Seeds the daemon connection BEFORE the very first navigation — exactly
  // what a returning browser's persisted settings look like — and runs on
  // every subsequent navigation too (context-scoped), so it is written once.
  await context.addInitScript((base) => {
    window.localStorage.setItem(
      'whiteboard:user-settings:v3',
      JSON.stringify({
        version: 3,
        storage: { daemonBaseUrl: base },
        migration: {},
        capabilities: {},
      }),
    )
  }, daemonBaseUrl)

  const page = await context.newPage()
  page.on('response', (res) => {
    void (async () => {
      let url
      try {
        url = new URL(res.url())
      } catch {
        return
      }
      if (url.origin !== daemonBaseUrl) return
      let errorField
      let replicaKeyBody
      const contentType = res.headers()['content-type'] ?? ''
      if (contentType.includes('application/json')) {
        try {
          const json = await res.json()
          errorField = typeof json?.error === 'string' ? json.error : undefined
          // Captured so check 1's sealed-at-rest assertion can check the
          // storage dump against this run's ACTUAL key bytes rather than a
          // fixture value — kept in the side-channel map below, never in
          // `daemonResponses` itself, so a failure message that stringifies
          // a log slice can never print key bytes.
          if (url.pathname.endsWith('/replica-key') && res.status() === 200) {
            replicaKeyBody = json
          }
        } catch {
          // Not a body worth reading (or the response already closed) — the
          // status code alone still tells every check below what happened.
        }
      }
      const index = daemonResponses.length
      daemonResponses.push({
        method: res.request().method(),
        path: url.pathname,
        status: res.status(),
        error: errorField,
      })
      if (replicaKeyBody !== undefined) replicaKeyBodies.set(index, replicaKeyBody)
    })()
  })
  page.on('console', (msg) => {
    // Every refusal below is asked for, and Chromium logs each 4xx as a
    // resource error; only anything else is worth a reader's attention.
    if (msg.type() === 'error' && !/status of 4\d\d/.test(msg.text())) {
      consoleErrors.push(msg.text())
    }
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

  // --- registration leg: a scratch session mints a passkey pin, seeded
  // into localStorage exactly as apps/web's registerPasskey would write it.
  await page.goto(APP, { waitUntil: 'load' })

  const scratchSession = await page.evaluate(async (daemon) => {
    const res = await fetch(`${daemon}/api/pairing/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grantType: 'origin' }),
    })
    return { status: res.status, body: await res.json() }
  }, daemonBaseUrl)
  check(
    scratchSession.status === 200 && typeof scratchSession.body?.token === 'string',
    'the app origin mints a pairing session token',
    `got ${scratchSession.status}`,
  )
  const scratchBearer = scratchSession.body.token

  const registration = await page.evaluate(
    async ({ daemon, bearer }) => {
      const b64u = (b) =>
        btoa(String.fromCharCode(...new Uint8Array(b)))
          .replaceAll('+', '-')
          .replaceAll('/', '_')
          .replaceAll('=', '')
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
    { daemon: daemonBaseUrl, bearer: scratchBearer },
  )
  check(
    registration.status === 201 && registration.body?.credentialId === registration.credentialId,
    'the browser registers a passkey and the daemon pins it (201)',
    redact(registration, scratchBearer),
  )
  const credentialId = registration.credentialId

  await page.evaluate(
    ({ key, base, credId, registeredAt }) => {
      window.localStorage.setItem(
        key,
        JSON.stringify({ [base]: { credentialId: credId, registeredAt } }),
      )
    },
    {
      key: PASSKEYS_KEY,
      base: daemonBaseUrl,
      credId: credentialId,
      registeredAt: new Date().toISOString(),
    },
  )

  const member = await operator(`/api/workspaces/${workspaceId}/members`, {
    method: 'POST',
    body: JSON.stringify({ credentialId, origin: APP, displayName: 'read-plane smoke member' }),
  })
  check(member.status === 201, 'the credential is admitted as a workspace member', redact(member))
  const profileId = member.body?.profileId

  const docUrl = `${APP}/w/${workspaceId}/d/${DOCUMENT_PATH}`

  // ==================================================================
  // Check 1 — paired + registered passkey + member: opening the daemon
  // workspace pulls a sealed replica.
  // ==================================================================
  let mark = daemonResponses.length
  await page.goto(docUrl, { waitUntil: 'load' })

  const sawRenewal = await waitUntil(
    () => daemonResponses.slice(mark).some((e) => e.path === '/api/pairing/token'),
    15_000,
  )
  check(sawRenewal, 'the cold load renews a pairing session (localStorage seed took effect)')

  const markerVisible = await page
    .getByText(MARKER)
    .first()
    .waitFor({ state: 'visible', timeout: 20_000 })
    .then(() => true)
    .catch(() => false)
  check(markerVisible, 'the daemon page shows the seeded marker body (negative control)')

  const registryWritten = await page
    .waitForFunction(
      (ws) => {
        try {
          const raw = window.localStorage.getItem('whiteboard:user-settings:v3')
          if (!raw) return false
          const parsed = JSON.parse(raw)
          return parsed?.storage?.replicas?.[ws] !== undefined
        } catch {
          return false
        }
      },
      workspaceId,
      { timeout: 20_000 },
    )
    .then(() => true)
    .catch(() => false)
  check(registryWritten, 'the replica registry entry is written after the pull')

  const check1Log = daemonResponses.slice(mark)
  const sessionAssertOk = check1Log.some(
    (e) => e.path === '/api/pairing/session-assert' && e.status === 200,
  )
  check(sessionAssertOk, 'the withheld first ask binds the session (session-assert 200 seen)')
  const replicaKeyIndex = daemonResponses.findIndex(
    (e, i) => i >= mark && e.path.endsWith('/replica-key') && e.status === 200,
  )
  check(
    replicaKeyIndex !== -1,
    'a replica-key request answers 200 once the session is bound',
    redact(check1Log),
  )

  // --- sealed-at-rest: dump IndexedDB + localStorage from the page and
  // assert neither the marker nor the real key bytes appear anywhere.
  const sealedDump = await page.evaluate(async () => {
    function collectStrings(value, out) {
      if (typeof value === 'string') out.push(value)
      else if (value instanceof ArrayBuffer) out.push(new TextDecoder().decode(value))
      else if (ArrayBuffer.isView(value)) {
        out.push(new TextDecoder().decode(value.buffer, value.byteOffset, value.byteLength))
      } else if (Array.isArray(value)) {
        for (const item of value) collectStrings(item, out)
      } else if (value && typeof value === 'object') {
        for (const item of Object.values(value)) collectStrings(item, out)
      }
      return out
    }
    const db = await new Promise((resolveDb, rejectDb) => {
      const req = indexedDB.open('whiteboard')
      req.onsuccess = () => resolveDb(req.result)
      req.onerror = () => rejectDb(req.error)
    })
    const strings = []
    for (const storeName of Array.from(db.objectStoreNames)) {
      const records = await new Promise((resolveStore, rejectStore) => {
        const req = db.transaction([storeName], 'readonly').objectStore(storeName).getAll()
        req.onsuccess = () => resolveStore(req.result)
        req.onerror = () => rejectStore(req.error)
      })
      collectStrings(records, strings)
    }
    db.close()
    const localStorageStrings = []
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i)
      if (key) localStorageStrings.push(window.localStorage.getItem(key) ?? '')
    }
    return { idb: strings, localStorage: localStorageStrings }
  })
  const markerLeaked =
    sealedDump.idb.some((s) => s.includes(MARKER)) ||
    sealedDump.localStorage.some((s) => s.includes(MARKER))
  check(!markerLeaked, 'IndexedDB and localStorage hold no plaintext marker')

  const replicaKeyBody = replicaKeyIndex === -1 ? undefined : replicaKeyBodies.get(replicaKeyIndex)
  const realKey = replicaKeyBody?.workspaceKey
  const realSalt = replicaKeyBody?.workspaceKeySalt
  const keyLeaked =
    typeof realKey === 'string' &&
    typeof realSalt === 'string' &&
    (sealedDump.idb.some((s) => s.includes(realKey) || s.includes(realSalt)) ||
      sealedDump.localStorage.some((s) => s.includes(realKey) || s.includes(realSalt)))
  check(
    typeof realKey === 'string' && typeof realSalt === 'string' && !keyLeaked,
    "IndexedDB and localStorage hold no bytes of this run's real workspace key",
  )

  // ==================================================================
  // Check 2 — daemon stopped, cold reload: replica-state-locked only
  // (ADR-0042 decision 2).
  // ==================================================================
  await running.close()

  mark = daemonResponses.length
  await page.goto(docUrl, { waitUntil: 'load' }).catch(() => {})

  const lockedVisible = await page
    .getByTestId('replica-state-locked')
    .waitFor({ state: 'visible', timeout: 20_000 })
    .then(() => true)
    .catch(() => false)
  check(lockedVisible, 'a cold reload with the daemon stopped lands on replica-state-locked')
  const readableAbsent = (await page.getByTestId('replica-state-readable').count()) === 0
  check(readableAbsent, 'replica-state-readable is absent while the daemon is down')
  const stateCount = await page.locator('[data-testid^="replica-state-"]').count()
  check(stateCount === 1, 'exactly one replica-state-* element is present', `got ${stateCount}`)

  // ==================================================================
  // Check 3 — daemon restarted on the same port/data dir, Reconnect
  // clicked: the renewal pairs and the replica page unmounts for the
  // daemon page.
  // ==================================================================
  running = await startHttpServer({
    port,
    host: '127.0.0.1',
    token: TOKEN,
    exitProcess: (code) => {
      throw new Error(`daemon exited fatally with code ${code}`)
    },
  })

  mark = daemonResponses.length
  await page.getByRole('button', { name: 'Reconnect' }).click()

  const replicaPageGone = await page
    .getByTestId('replica-read-page')
    .waitFor({ state: 'detached', timeout: 20_000 })
    .then(() => true)
    .catch(() => false)
  check(replicaPageGone, 'Reconnect unmounts the replica page for the daemon page')

  const markerVisibleAgain = await page
    .getByText(MARKER)
    .first()
    .waitFor({ state: 'visible', timeout: 20_000 })
    .then(() => true)
    .catch(() => false)
  check(markerVisibleAgain, 'the daemon page shows the marker again after reconnecting')

  const check3Log = daemonResponses.slice(mark)
  const noPushAfterReconnect = check3Log.filter((e) =>
    e.path.endsWith('/workspace-document/update'),
  ).length
  check(
    noPushAfterReconnect === 0,
    'a clean replica ships no push after reconnecting',
    redact(check3Log),
  )

  // ==================================================================
  // Check 4 — member removed while the daemon stays up, cold reload: the
  // daemon page mounts (a member removal does not revoke the origin
  // grant), and the replica-key ask is refused for real — nothing is sent.
  // ==================================================================
  const removed = await operator(`/api/workspaces/${workspaceId}/members/${profileId}`, {
    method: 'DELETE',
  })
  check(
    removed.status === 200 && removed.body?.removed === true,
    'the member is removed',
    redact(removed),
  )

  mark = daemonResponses.length
  await page.goto(docUrl, { waitUntil: 'load' })

  const daemonPageMounted = await waitUntil(
    () =>
      page
        .getByText(MARKER)
        .first()
        .isVisible()
        .catch(() => false),
    20_000,
  )
  check(
    daemonPageMounted,
    'a removed member still lands on the daemon page (the grant is untouched)',
  )
  const noReplicaStateElement =
    (await page.locator('[data-testid^="replica-state-"]').count()) === 0
  check(noReplicaStateElement, 'no replica-state-* element renders — this is not the removed page')

  await waitUntil(
    () =>
      daemonResponses.slice(mark).some((e) => e.path.endsWith('/replica-key') && e.status === 403),
    15_000,
  )
  const check4Log = daemonResponses.slice(mark)
  const sessionAssertIdx = check4Log.findIndex(
    (e) => e.path === '/api/pairing/session-assert' && e.status === 200,
  )
  check(
    sessionAssertIdx !== -1,
    'the new session binds again (session-assert 200)',
    redact(check4Log),
  )
  const refusalAfterBind = check4Log
    .slice(sessionAssertIdx + 1)
    .find((e) => e.path.endsWith('/replica-key'))
  check(
    refusalAfterBind?.status === 403 && refusalAfterBind?.error === 'not_a_member',
    'the bound session is refused the key as `not_a_member`',
    redact(check4Log),
  )
  const noPushAfterRemoval = check4Log.filter((e) =>
    e.path.endsWith('/workspace-document/update'),
  ).length
  check(noPushAfterRemoval === 0, 'nothing is sent once the key is withheld (ADR-0042 decision 4)')

  // ==================================================================
  // Check 5 — member re-added, origin grant revoked, cold reload:
  // replica-state-unpaired, never removed (ADR-0042 decision 5).
  // ==================================================================
  const readded = await operator(`/api/workspaces/${workspaceId}/members`, {
    method: 'POST',
    body: JSON.stringify({ credentialId, origin: APP, displayName: 'read-plane smoke member' }),
  })
  check(readded.status === 201, 're-adding the member succeeds', redact(readded))

  const revoked = await operator(`/api/pairing/grants/${grantId}`, { method: 'DELETE' })
  check(
    revoked.status === 200 && revoked.body?.revoked === true,
    'the origin grant is revoked',
    redact(revoked),
  )

  await page.goto(docUrl, { waitUntil: 'load' })

  const unpairedVisible = await page
    .getByTestId('replica-state-unpaired')
    .waitFor({ state: 'visible', timeout: 20_000 })
    .then(() => true)
    .catch(() => false)
  check(unpairedVisible, 'a revoked origin grant lands on replica-state-unpaired')
  const removedAbsent = (await page.getByTestId('replica-state-removed').count()) === 0
  check(removedAbsent, 'replica-state-removed never renders for a revoked grant')
  const noButton = (await page.getByRole('button').count()) === 0
  check(noButton, 'the unpaired state offers no action button')

  await context.close()
} catch (err) {
  fail(`unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
} finally {
  await browser.close()
  await running.close().catch(() => {})
  staticServer.close()
  rmSync(dataDir, { recursive: true, force: true })
}

/** Polls `fn` until it answers true or `timeoutMs` elapses — no fixed
 *  sleeps, only a bounded wait on a real condition. */
async function waitUntil(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return await fn()
}

if (consoleErrors.length > 0) {
  console.log(`  note  browser console errors observed:\n    ${consoleErrors.join('\n    ')}`)
}
if (failed) {
  console.error(`${TAG} FAIL`)
  process.exit(1)
}
console.log(`${TAG} PASS`)
