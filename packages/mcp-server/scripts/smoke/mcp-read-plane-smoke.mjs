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
// 4. The workspace's SOLE member removed while the daemon stays up, cold
//    reload: a workspace that has ever had a member stays person-gated
//    even with none left (ADR-0041 S8 slice 4, user decision 2026-09-21),
//    so the origin-only renewal no longer pairs — it is refused
//    `requires_person_session`, the removed member's still-pinned passkey
//    binds again (session-assert 200), and the bound retry is refused
//    `not_a_member` (their L1 membership, not their passkey pin, was
//    revoked). That refusal is what mounts `replica-state-removed`
//    (S5's page, the same `not_a_member` branch #1734 wired) — nothing is
//    sent once the key is withheld (ADR-0042 decision 4).
// 4b. The gate REOPENED to origin trust with the daemon token, cold
//    reload: the renewal check 4 saw refused now pairs and the daemon page
//    mounts, with no membership refusal left in the log. Asking twice
//    reports `wasMembersOnly:false` the second time. The refusal side of
//    that bar is not observable here (no non-daemon caller exists in this
//    smoke) and is covered by `membership.test.ts` through the real
//    middleware.
// 5. The origin grant revoked (member re-added first): `replica-state-
//    unpaired`, never `removed` — ADR-0042 decision 5's distinction
//    between a pairing refusal and a membership refusal.
// 6. Skipped: `no-offline` cannot render `replica-state-needs-connection`
//    in this composed app either — every check here keeps the daemon UP,
//    so the renewal always reaches it and mounts either the daemon page or
//    a membership-refusal replica state, never the "no daemon reachable"
//    one. The observable (a `replica_not_allowed` 403, no registry entry)
//    is already pinned by replica-key.test.ts.
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
// Runs IN the page (serialised by Playwright), so it may close over nothing.
const replicaRegistered = (ws) => {
  try {
    const raw = window.localStorage.getItem('whiteboard:user-settings:v3')
    return raw !== null && JSON.parse(raw)?.storage?.replicas?.[ws] !== undefined
  } catch {
    return false
  }
}

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

/**
 * Everything this origin has PERSISTED, in the three forms a leak could take
 * — runs inside the page, so it names nothing from this module.
 *
 * Strings are searched as text; binary values are searched as BYTES (a
 * persisted key would be the decoded 32 bytes, not its base64url spelling,
 * and a UTF-8 decode of ciphertext can never contain it); a persisted
 * `CryptoKey` is a leak on its own, whatever it holds.
 */
async function dumpPersistedValues(needleBytes) {
  const hasSubsequence = (hay, needle) => {
    outer: for (let i = 0; i + needle.length <= hay.length; i++) {
      for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
      return true
    }
    return false
  }
  const asBytes = (value) =>
    value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  const readRequest = (request) =>
    new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })

  const isBinary = (value) => value instanceof ArrayBuffer || ArrayBuffer.isView(value)
  const isCryptoKey = (value) => typeof CryptoKey !== 'undefined' && value instanceof CryptoKey

  const strings = []
  let cryptoKeys = 0
  let byteHits = 0
  // One line per KIND of value, each delegating: a walker that also decoded
  // bytes and counted needles inline was the whole of this file's complexity.
  const collectBinary = (value) => {
    const bytes = asBytes(value)
    for (const needle of needleBytes) if (hasSubsequence(bytes, needle)) byteHits += 1
    strings.push(new TextDecoder().decode(bytes))
  }
  const collectEach = (values) => {
    for (const item of values) collect(item)
  }
  function collect(value) {
    if (typeof value === 'string') strings.push(value)
    else if (isCryptoKey(value)) cryptoKeys += 1
    else if (isBinary(value)) collectBinary(value)
    else if (Array.isArray(value)) collectEach(value)
    else if (value && typeof value === 'object') collectEach(Object.values(value))
  }

  const db = await readRequest(indexedDB.open('whiteboard'))
  for (const storeName of Array.from(db.objectStoreNames)) {
    collect(
      await readRequest(db.transaction([storeName], 'readonly').objectStore(storeName).getAll()),
    )
  }
  db.close()

  const localStorageStrings = []
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i)
    if (key) localStorageStrings.push(window.localStorage.getItem(key) ?? '')
  }
  return { idb: strings, localStorage: localStorageStrings, cryptoKeys, byteHits }
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
  // what a returning browser's persisted settings look like. `addInitScript`
  // runs before EVERY navigation in this context (it is context-scoped, not
  // one-shot), so it must seed only when the key is ABSENT: check 1's pull
  // writes a `storage.replicas` entry this build reads on every later cold
  // reload, and an unconditional write here clobbered it on each navigation,
  // erasing the registry before the smoke ever asked for the locked state.
  await context.addInitScript((base) => {
    const KEY = 'whiteboard:user-settings:v3'
    if (window.localStorage.getItem(KEY) !== null) return
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        version: 3,
        storage: { daemonBaseUrl: base },
        migration: {},
        capabilities: {},
      }),
    )
  }, daemonBaseUrl)

  const page = await context.newPage()
  // Response METADATA is recorded synchronously, in arrival order, so a
  // log slice taken between two marks is complete and never reordered by a
  // slow body read; the body reads that fill in `error` and capture the key
  // are tracked in `pendingBodies` and awaited by `settleResponses()` before
  // every assertion that reads the log.
  const pendingBodies = []
  page.on('response', (res) => {
    let url
    try {
      url = new URL(res.url())
    } catch {
      return
    }
    if (url.origin !== daemonBaseUrl) return
    const index = daemonResponses.length
    const entry = {
      method: res.request().method(),
      path: url.pathname,
      status: res.status(),
      error: undefined,
    }
    daemonResponses.push(entry)
    const contentType = res.headers()['content-type'] ?? ''
    if (!contentType.includes('application/json')) return
    pendingBodies.push(
      res
        .json()
        .then((json) => {
          entry.error = typeof json?.error === 'string' ? json.error : undefined
          // Captured so check 1's sealed-at-rest assertion can check the
          // storage dump against this run's ACTUAL key bytes rather than a
          // fixture value — kept in the side-channel map, never in
          // `daemonResponses` itself, so a failure message that stringifies
          // a log slice can never print key bytes.
          if (url.pathname.endsWith('/replica-key') && res.status() === 200) {
            replicaKeyBodies.set(index, json)
          }
        })
        .catch(() => {
          // Not a body worth reading (or the response already closed) — the
          // status code alone still tells every check below what happened.
        }),
    )
  })
  const settleResponses = () => Promise.all(pendingBodies.splice(0))
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
    .waitForFunction(replicaRegistered, workspaceId, { timeout: 20_000 })
    .then(() => true)
    .catch(() => false)
  check(registryWritten, 'the replica registry entry is written after the pull')

  await settleResponses()
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
  const replicaKeyBody = replicaKeyIndex === -1 ? undefined : replicaKeyBodies.get(replicaKeyIndex)
  const realKey = replicaKeyBody?.workspaceKey
  const realSalt = replicaKeyBody?.workspaceKeySalt
  const b64uToBytes = (text) => Array.from(Buffer.from(text, 'base64url'))
  const needles =
    typeof realKey === 'string' && typeof realSalt === 'string'
      ? [b64uToBytes(realKey), b64uToBytes(realSalt)]
      : []
  const sealedDump = await page.evaluate(dumpPersistedValues, needles)
  const markerLeaked =
    sealedDump.idb.some((s) => s.includes(MARKER)) ||
    sealedDump.localStorage.some((s) => s.includes(MARKER))
  check(!markerLeaked, 'IndexedDB and localStorage hold no plaintext marker')

  const keyLeaked =
    sealedDump.byteHits > 0 ||
    sealedDump.cryptoKeys > 0 ||
    sealedDump.idb.some((s) => s.includes(realKey) || s.includes(realSalt)) ||
    sealedDump.localStorage.some((s) => s.includes(realKey) || s.includes(realSalt))
  check(
    needles.length === 2 && !keyLeaked,
    "IndexedDB and localStorage hold no bytes of this run's real workspace key (raw, base64url, or as a CryptoKey)",
    `byteHits=${sealedDump.byteHits} cryptoKeys=${sealedDump.cryptoKeys} keyKnown=${needles.length === 2}`,
  )

  // ==================================================================
  // Check 2 — daemon stopped, cold reload: replica-state-locked only
  // (ADR-0042 decision 2).
  // ==================================================================
  await running.close()

  mark = daemonResponses.length
  await page.goto(docUrl, { waitUntil: 'load' }).catch(() => {})

  const registrySurvivedReload = await page.evaluate(replicaRegistered, workspaceId)
  check(
    registrySurvivedReload,
    'the registry entry survives the cold reload',
    'a fresh navigation must never re-seed localStorage over an existing replica registry',
  )

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

  await settleResponses()
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
  // Check 4 — the workspace's SOLE member removed while the daemon stays
  // up, cold reload: the workspace stays person-gated (S12), the removed
  // member's still-pinned passkey binds again, the bound retry is refused
  // `not_a_member`, and that refusal lands on `replica-state-removed`.
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

  const removedPageVisible = await page
    .getByTestId('replica-state-removed')
    .waitFor({ state: 'visible', timeout: 20_000 })
    .then(() => true)
    .catch(() => false)
  check(removedPageVisible, 'the sole member removed lands on replica-state-removed')
  const replicaStateCount = await page.locator('[data-testid^="replica-state-"]').count()
  check(
    replicaStateCount === 1,
    `exactly one replica-state-* element renders (got ${replicaStateCount})`,
  )
  const removedBody = await page.getByTestId('replica-state-removed').textContent()
  check(
    (removedBody ?? '').includes('changes made since then were not sent'),
    'the removed page says the local changes were not sent',
    redact(removedBody ?? ''),
  )

  await settleResponses()
  const check4Log = daemonResponses.slice(mark)
  const sessionAssertIdx = check4Log.findIndex(
    (e) => e.path === '/api/pairing/session-assert' && e.status === 200,
  )
  check(
    sessionAssertIdx !== -1,
    'the removed member’s passkey binds again (session-assert 200)',
    redact(check4Log),
  )
  const refusalAfterBind = check4Log.slice(sessionAssertIdx + 1).find((e) => e.status === 403)
  check(
    refusalAfterBind?.error === 'not_a_member',
    'the bound retry is refused `not_a_member`',
    redact(check4Log),
  )
  const refusalIdx = refusalAfterBind === undefined ? -1 : check4Log.indexOf(refusalAfterBind)
  // Nothing document-bearing follows the refusal: no push, no sync
  // subscribe, no replica-key ask, no re-fetch of the documents list.
  const CONTENT_ROUTE = /\/(workspace-document|api\/sync|replica-key|documents)(\/|$|\?)/
  const sentAfterRefusal =
    refusalIdx === -1
      ? []
      : check4Log
          .slice(refusalIdx + 1)
          .filter((e) => ['POST', 'PUT', 'PATCH'].includes(e.method) && CONTENT_ROUTE.test(e.path))
  check(
    sentAfterRefusal.length === 0,
    'nothing is sent once the key is withheld (ADR-0042 decision 4)',
    redact(sentAfterRefusal),
  )

  // ==================================================================
  // Check 4b — the gate REOPENED to origin trust with the daemon token,
  // cold reload: the same origin-only renewal that check 4 just saw
  // refused now pairs, and the daemon page mounts. This exists because
  // check 4 is what found the original gap; the exit it asked for has to
  // be observed reversing it against the same running daemon, not only in
  // a unit test where the store is the only thing watching.
  //
  // `operator()` carries the daemon token, which is the only credential
  // this route accepts (`daemon-token-only`, judged by grant KIND — a
  // paired browser's grant carries every scope and is still refused).
  // Nothing here can prove the refusal side: this smoke has no non-daemon
  // caller to try it with, and `membership.test.ts` covers that through
  // the real middleware instead.
  // ==================================================================
  const reopened = await operator(`/api/workspaces/${workspaceId}/members-only`, {
    method: 'DELETE',
  })
  check(
    reopened.status === 200 && reopened.body?.wasMembersOnly === true,
    'the gate reopens and reports that it had been closed',
    redact(reopened),
  )

  mark = daemonResponses.length
  await page.goto(docUrl, { waitUntil: 'load' })

  const reopenedPageGone = await page
    .getByTestId('replica-read-page')
    .waitFor({ state: 'detached', timeout: 20_000 })
    .then(() => true)
    .catch(() => false)
  check(
    reopenedPageGone,
    'the reopened workspace mounts the daemon page, not a replica state',
    redact(daemonResponses.slice(mark)),
  )

  const markerAfterReopen = await page
    .getByText(MARKER)
    .first()
    .waitFor({ state: 'visible', timeout: 20_000 })
    .then(() => true)
    .catch(() => false)
  check(markerAfterReopen, 'the reopened workspace shows its content again')

  await settleResponses()
  const check4bLog = daemonResponses.slice(mark)
  // The discriminator against "it worked for some other reason": the
  // refusal check 4 saw on this exact renewal is GONE, rather than merely
  // followed by something that succeeded.
  const stillRefused = check4bLog.filter(
    (e) =>
      e.status === 403 && (e.error === 'not_a_member' || e.error === 'requires_person_session'),
  )
  check(
    stillRefused.length === 0,
    'no membership refusal remains on the reopened workspace',
    redact(stillRefused),
  )

  const secondReopen = await operator(`/api/workspaces/${workspaceId}/members-only`, {
    method: 'DELETE',
  })
  check(
    secondReopen.status === 200 && secondReopen.body?.wasMembersOnly === false,
    'asking twice says the second time there was nothing to clear',
    redact(secondReopen),
  )

  // ==================================================================
  // Check 5 — member re-added, origin grant revoked, cold reload:
  // replica-state-unpaired, never removed (ADR-0042 decision 5). Re-adding
  // the member also RE-CLOSES the gate check 4b just opened, which is the
  // one-shot property stated in the store: a reopen is not a mode.
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
  // Scoped to the replica page itself, not the whole page: AppShell's own
  // chrome (the connection-status marker, fullscreen, settings) renders
  // real buttons regardless of replica state, so counting page-wide finds
  // those instead of asking anything about ReplicaReadPage.
  const noButton = (await page.getByTestId('replica-read-page').getByRole('button').count()) === 0
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

// Check 2 stops the daemon on purpose, so a refused connection is the one
// console error the run expects; anything else is a page error nobody asked
// for and fails the run rather than being noted.
const unexpectedConsole = consoleErrors.filter((m) => !/ERR_CONNECTION_REFUSED/.test(m))
if (unexpectedConsole.length > 0) {
  console.error(`  FAIL  browser console errors observed:\n    ${unexpectedConsole.join('\n    ')}`)
  failed = true
}
if (failed) {
  console.error(`${TAG} FAIL`)
  process.exit(1)
}
console.log(`${TAG} PASS`)
