// Real-browser proof of the read plane (ADR-0042 decisions 2-3, ADR-0023's
// offline read) as a person meets it today: the built web app reaches a
// REAL daemon through the extension (ADR-0050), pulls a sealed replica into
// real IndexedDB, and reads it when the daemon is gone.
//
// Why this exists beside the browser-mode tests: every one of them fakes the
// daemon at `fetch`, and every route test fakes the browser. Nothing else
// watches the composed system — real ciphertext in real IndexedDB, a real
// cold start that has lost the key, a real daemon coming back.
//
// The key: the native host carries the daemon's own operator-issued
// credential, which the replica-key route admits without a membership or a
// passkey (workspace-access.ts), so the pull needs neither. ADR-0050's
// 2026-09-28 addendum decision 8 keeps a passkey's PRF as what can wrap that
// key for a later cold start, and decision 11 makes that opt-in from
// Settings: until a person asks, nothing is wrapped and a cold start must find
// the replica locked.
//
// What this pins, in the order a person meets it:
// 1. Opening a daemon workspace through the extension pulls a SEALED
//    replica: every blob stored for it is an envelope rather than a Loro
//    export, and IndexedDB and localStorage hold neither the document's
//    plaintext body nor this run's workspace key bytes.
// 2. The daemon stopped, a cold reload: `replica-state-locked` (ADR-0042
//    decision 2 — the key lived in memory only).
// 3. The daemon restarted, Reconnect clicked: the reconnection lands and the
//    replica page unmounts for the daemon page.
// 4. Settings > Connections, "Make readable offline" on the copy's row: a
//    passkey is created in this browser (Chromium's virtual authenticator,
//    with PRF) and the key is wrapped under it — still no key bytes at rest.
// 5. The daemon stopped again, a cold reload: the copy is now unlockable, one
//    passkey gesture opens it, and the note reads with no daemon.
//
// WebAuthn refuses an IP address as a relying party, so the app is opened at
// `localhost` rather than the `127.0.0.1` the server listens on.
//
// What it no longer pins, and why. It used to reach the daemon over loopback
// with a pairing grant, and so also checked a member removed from the
// workspace (the removed page), the gate reopening to origin trust, and an
// origin grant revoked (the unpaired page). Those are local member
// management and pairing, which ADR-0050 decision 3 retires: a local daemon
// has one person, and the extension carries its own credential. Server mode
// is where members are removed, and its routes are pinned there. It also
// asserted, from the page's own request log, that a clean replica shipped
// no push after reconnecting; the bridge carries requests inside the
// extension, where a page cannot watch them, and replica-refresh's own tests
// hold that rule.
//
// Branded Chrome ignores --load-extension, so this needs Playwright's own
// Chromium: `pnpm exec playwright install chromium`.
import { mkdtempSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import {
  buildAll,
  callTool,
  createSmoke,
  daemonApi,
  EXTENSION_DIR,
  serve,
  startDaemon,
  stopDaemon,
  whiteboard,
} from './smoke-kit.mjs'

const BRIDGE_DAEMON_BASE_URL = 'https://daemon.whiteboard.invalid'
/**
 * The live settings key and version, read off the store rather than
 * remembered here. A key remembered here goes stale the next time the store
 * bumps its version, and the failure is indirect: the seed below still
 * works, through the one-time legacy migration, while the registry probe
 * reads a key the app has stopped writing — so a replica the pull DID
 * register reads as unregistered.
 */
const SETTINGS = (() => {
  const source = readFileSync(
    resolve(EXTENSION_DIR, '../web/src/lib/user-settings-store.ts'),
    'utf8',
  )
  const match = /export const STORAGE_KEY = '(whiteboard:user-settings:v(\d+))'/.exec(source)
  if (match === null) {
    throw new Error(
      'user-settings-store.ts no longer declares STORAGE_KEY the way this script reads it',
    )
  }
  return { key: match[1], version: Number(match[2]) }
})()
const DOCUMENT_PATH = 'read-plane-note'
const MARKER = 'read-plane-smoke-marker-body-text'
const smoke = createSmoke('read-plane-smoke')
const { check, dataDir, scratch } = smoke

// Runs IN the page (serialised by Playwright), so it may close over nothing.
const replicaRegistered = ({ ws, key }) => {
  try {
    const raw = window.localStorage.getItem(key)
    return raw !== null && JSON.parse(raw)?.storage?.replicas?.[ws] !== undefined
  } catch {
    return false
  }
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

/**
 * The replica's own stored blobs — snapshot chunks and deltas kept under
 * `workspace-tree:<id>` — and how many of them begin with Loro's `loro`
 * magic, which every export Loro writes starts with. A sealed blob is an
 * envelope, so none may. Runs inside the page.
 *
 * This is what makes the sealed-at-rest claim checkable: Loro compresses a
 * snapshot's text, so the marker is absent from an UNSEALED replica too —
 * measured, a store that skipped sealing passed the marker search.
 */
async function replicaBlobs(workspaceId) {
  const ref = `workspace-tree:${workspaceId}`
  const readRequest = (request) =>
    new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  const asBytes = (value) =>
    value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : null
  // A chunk carries its bytes; a record carries its delta log. The record's
  // frontier is version metadata, plaintext by design.
  const blobsOf = (value) =>
    [value?.bytes, ...(value?.deltas ?? [])]
      .map((candidate) => asBytes(candidate?.bytes ?? candidate))
      .filter((bytes) => bytes !== null && bytes.length > 0)
  const blobs = []
  const db = await readRequest(indexedDB.open('whiteboard'))
  for (const storeName of Array.from(db.objectStoreNames)) {
    const store = db.transaction([storeName], 'readonly').objectStore(storeName)
    const [keys, values] = await Promise.all([
      readRequest(store.getAllKeys()),
      readRequest(store.getAll()),
    ])
    keys.forEach((key, i) => {
      if ((Array.isArray(key) ? key[0] : key) === ref) blobs.push(...blobsOf(values[i]))
    })
  }
  db.close()
  const magic = [0x6c, 0x6f, 0x72, 0x6f]
  const loroHeaded = blobs.filter((b) => magic.every((byte, i) => b[i] === byte)).length
  return { blobs: blobs.length, loroHeaded }
}

/**
 * A platform-style authenticator with PRF and user verification, answering
 * every prompt on its own — what a person's passkey provider does after they
 * confirm. Scoped to this page's target, so it survives a reload of the page.
 */
async function addPrfAuthenticator(context, page) {
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
  })
}

/** Waits for a test id to reach `state`; answers whether it did. */
const reached = (page, testId, state, timeout = 30_000) =>
  page
    .getByTestId(testId)
    .waitFor({ state, timeout })
    .then(
      () => true,
      () => false,
    )

const markerShown = (page) =>
  page
    .getByText(MARKER)
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 })
    .then(
      () => true,
      () => false,
    )

/**
 * A browser with the development extension loaded and the native host
 * installed for it, remembering the daemon as reached through the extension —
 * what a returning person's settings hold. Seeded only while the key is
 * absent: the pull writes a replica registry into the same record, and a
 * seed on every navigation would erase it before the cold start asks for it.
 */
async function openBrowser() {
  const profile = mkdtempSync(join(scratch, 'profile-'))
  whiteboard([
    'native-host',
    'install',
    '--json',
    `--data-dir=${dataDir}`,
    `--manifest-dir=${join(profile, 'NativeMessagingHosts')}`,
  ])
  const extensionDir = join(EXTENSION_DIR, 'dist/development')
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  })
  await context.addInitScript(
    ({ key, version, base }) => {
      if (window.localStorage.getItem(key) !== null) return
      window.localStorage.setItem(
        key,
        JSON.stringify({
          version,
          storage: { daemonBaseUrl: base },
          migration: {},
          capabilities: {},
        }),
      )
    },
    { key: SETTINGS.key, version: SETTINGS.version, base: BRIDGE_DAEMON_BASE_URL },
  )
  return context
}

/** The daemon's `default` workspace, with a note holding the marker. */
async function seedWorkspace(record) {
  await callTool(record, 'wb_workspace_edit', {
    workspaceId: 'default',
    createWorkspace: true,
    ops: [
      {
        op: 'document.create',
        path: DOCUMENT_PATH,
        kind: 'markdown',
        name: 'Read-plane note',
        markdown: MARKER,
      },
    ],
  })
  const { json } = await daemonApi(record, 'GET', '/api/workspaces')
  return json?.workspaces?.find((w) => w.segment === 'default')?.workspaceId
}

/** This run's real workspace key, asked the way the page asks for it. */
async function workspaceKeyBytes(record, workspaceId) {
  const { status, json } = await daemonApi(
    record,
    'POST',
    `/api/workspaces/${encodeURIComponent(workspaceId)}/replica-key`,
  )
  if (status !== 200) return []
  return [json.workspaceKey, json.workspaceKeySalt].map((text) =>
    Array.from(Buffer.from(text, 'base64url')),
  )
}

async function readPlane(record, appUrl, restartDaemon) {
  const workspaceId = await seedWorkspace(record)
  check(typeof workspaceId === 'string', 'the daemon holds a workspace to replicate', workspaceId)
  const context = await openBrowser()
  try {
    const page = await context.newPage()
    await addPrfAuthenticator(context, page)
    const docUrl = `${appUrl}w/${workspaceId}/d/${DOCUMENT_PATH}`

    // --- 1. the pull, sealed at rest --------------------------------------
    await page.goto(docUrl)
    check(
      await markerShown(page),
      'the cold load reconnects through the extension and shows the note',
      page.url(),
    )
    const registered = await page
      .waitForFunction(
        replicaRegistered,
        { ws: workspaceId, key: SETTINGS.key },
        { timeout: 30_000 },
      )
      .then(
        () => true,
        () => false,
      )
    check(registered, 'the replica registry entry is written after the pull', page.url())

    const needles = await workspaceKeyBytes(record, workspaceId)
    check(needles.length === 2, "this run's workspace key is known to the check", needles.length)
    const dump = await page.evaluate(dumpPersistedValues, needles)
    const markerLeaked =
      dump.idb.some((s) => s.includes(MARKER)) || dump.localStorage.some((s) => s.includes(MARKER))
    check(!markerLeaked, 'IndexedDB and localStorage hold no plaintext marker', 'marker found')
    check(
      dump.byteHits === 0 && dump.cryptoKeys === 0,
      "IndexedDB and localStorage hold no bytes of this run's workspace key (raw or as a CryptoKey)",
      `byteHits=${dump.byteHits} cryptoKeys=${dump.cryptoKeys}`,
    )
    const stored = await page.evaluate(replicaBlobs, workspaceId)
    check(
      stored.blobs > 0 && stored.loroHeaded === 0,
      'every stored blob of the replica is sealed, none a Loro export',
      JSON.stringify(stored),
    )

    // --- 2. daemon stopped, cold reload: locked ---------------------------
    const restarted = await restartDaemon(async () => {
      await page.goto(docUrl)
      check(
        await page.evaluate(replicaRegistered, { ws: workspaceId, key: SETTINGS.key }),
        'the registry entry survives the cold reload',
        'a fresh navigation must never re-seed over an existing replica registry',
      )
      check(
        await reached(page, 'replica-state-locked', 'visible'),
        'a cold reload with the daemon stopped lands on replica-state-locked',
        `${page.url()} ${(await page.locator('body').innerText()).slice(0, 200)}`,
      )
      check(
        (await page.getByTestId('replica-state-readable').count()) === 0,
        'replica-state-readable is absent while the daemon is down',
        'readable shown',
      )
      const states = await page.locator('[data-testid^="replica-state-"]').count()
      check(states === 1, 'exactly one replica-state-* element is present', `got ${states}`)
    })

    // --- 3. daemon back, Reconnect: the daemon page returns ---------------
    await page.getByRole('button', { name: 'Reconnect' }).click()
    check(
      await reached(page, 'replica-read-page', 'detached'),
      'Reconnect unmounts the replica page for the daemon page',
      page.url(),
    )
    check(
      await markerShown(page),
      'the daemon page shows the note again after reconnecting',
      page.url(),
    )

    // --- 4. Settings: make the copy readable offline ----------------------
    await page.goto(`${appUrl}settings/connections`)
    const offlineRow = page.getByTestId(`local-copy-offline-${workspaceId}`)
    // Enabled, not merely present: the row renders disabled until the page
    // has reconnected through the extension, which is the state being waited on.
    const makeReadable = offlineRow.locator('button:enabled', {
      hasText: 'Make readable offline',
    })
    const enabled = await makeReadable.waitFor({ state: 'visible', timeout: 30_000 }).then(
      () => true,
      () => false,
    )
    check(
      enabled,
      "the copy's row offers 'Make readable offline' while the daemon is connected",
      (await offlineRow.innerText().catch(() => '')).slice(0, 300),
    )
    if (enabled) await makeReadable.click()
    const optedIn = await offlineRow
      .getByText('Readable offline with your passkey.')
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(
        () => true,
        () => false,
      )
    check(
      optedIn,
      'the row says the copy is readable offline',
      (await offlineRow.innerText().catch(() => '')).slice(0, 300),
    )
    const afterOptIn = await page.evaluate(dumpPersistedValues, needles)
    check(
      afterOptIn.byteHits === 0 && afterOptIn.cryptoKeys === 0,
      "after the opt-in, storage still holds no bytes of this run's workspace key",
      `byteHits=${afterOptIn.byteHits} cryptoKeys=${afterOptIn.cryptoKeys}`,
    )

    // --- 5. daemon stopped, cold reload: one passkey gesture opens it -----
    await restartDaemon(async () => {
      await page.goto(docUrl)
      check(
        await reached(page, 'replica-state-unlockable', 'visible'),
        'a cold reload with the daemon stopped offers the passkey unlock',
        `${page.url()} ${(await page.locator('body').innerText()).slice(0, 200)}`,
      )
      await page.getByRole('button', { name: 'Unlock with your passkey' }).click()
      check(
        await reached(page, 'replica-state-readable', 'visible'),
        'the unlock opens the copy with the daemon stopped',
        `${page.url()} ${(await page.locator('body').innerText()).slice(0, 200)}`,
      )
      await page.getByText('Read-plane note').first().click()
      check(
        await markerShown(page),
        'the copy opened offline shows the note',
        (await page.locator('body').innerText()).slice(0, 300),
      )
    })
    return restarted
  } finally {
    await context.close()
  }
}

let daemon
const webApp = await serve()
try {
  buildAll()
  const started = await startDaemon(dataDir)
  daemon = started.daemon
  const appUrl = webApp.url.replace('127.0.0.1', 'localhost')
  await readPlane(started.record, appUrl, async (whileDown) => {
    await stopDaemon(daemon)
    daemon = undefined
    await whileDown()
    const again = await startDaemon(dataDir)
    daemon = again.daemon
    return again.record
  })
} catch (err) {
  check(false, 'the smoke ran to the end', err instanceof Error ? err.message : String(err))
} finally {
  webApp.close()
  await stopDaemon(daemon)
  smoke.finish()
}
