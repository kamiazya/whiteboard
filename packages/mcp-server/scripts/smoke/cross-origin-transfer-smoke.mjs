#!/usr/bin/env node
// Real-browser proof of ADR-0044's cross-origin workspace transfer, end to
// end: a browser-kept workspace at one origin sent to a REAL server-mode
// keeper at another, accepted by a person signed in there.
//
// Why this exists beside the browser-mode tests: those mount the sender and
// the receiver with a stubbed keeper and a stubbed opener. What they cannot
// see is the composed system — the keeper's own headers (a baseline
// `Cross-Origin-Opener-Policy: same-origin` severs `window.opener`, so the
// receiver's handshake would never start), a session cookie set by a real
// OIDC sign-in, and the promote route authorising the merge by it.
//
// The pieces, each as it runs in a deployment:
// - origin A: the built web app, served statically with its hosting's
//   `/*` headers, in browser mode;
// - origin B: `whiteboard server run` from the built dist, which serves its
//   own web build marked `keeper: 'server'`, behind a TLS-terminating proxy
//   (server mode refuses a non-https external URL, so one is always there);
// - the identity provider: `fakeOidcProvider`, which signs and checks for
//   real, served over https so the browser is redirected to it and the
//   keeper's relying party reaches it over the network.
//
// What it pins:
// 1. Signed out at B, the transfer window shows the sign-in notice, Accept
//    stays disabled, and nothing is merged.
// 2. Signed in at B as a member of a workspace, the window at B's
//    `/receive-transfer` hears from its opener, Accept merges, the sender
//    reports it, and B's own API lists the document afterwards.
//
// Needs the built dist (`pnpm build`) and Playwright's Chromium or
// WHITEBOARD_CHROME_PATH. Run: `pnpm smoke:transfer`.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { fakeOidcProvider } from '../../src/shared/test-utils/fake-oidc-provider.ts'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const CLI = join(PACKAGE_ROOT, 'dist/cli/index.js')
const WEB_DIST = resolve(PACKAGE_ROOT, '../../apps/web/dist')
const LABEL = '[transfer-smoke]'
const WAIT_MS = 20_000
const NOTE_TITLE = 'Transfer smoke note'
const PERSON = { sub: 'transfer-smoke-person', name: 'Transfer Smoke' }

for (const required of [CLI, join(PACKAGE_ROOT, 'dist/web-app/index.html'), WEB_DIST]) {
  if (!existsSync(required)) {
    console.error(`${LABEL} FAIL: ${required} is missing — run \`pnpm build\` first`)
    process.exit(1)
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'whiteboard-transfer-smoke-'))
let failed = false
function check(ok, what, detail = '') {
  console[ok ? 'log' : 'error'](`  ${ok ? 'pass' : 'FAIL'}  ${what}${ok ? '' : ` — ${detail}`}`)
  if (!ok) failed = true
}

/** One self-signed certificate for both https servers here; the keeper trusts it as a CA. */
function selfSignedCertificate() {
  const [key, cert, cnf] = ['key.pem', 'cert.pem', 'openssl.cnf'].map((f) => join(scratch, f))
  writeFileSync(
    cnf,
    [
      '[req]',
      'distinguished_name = dn',
      'x509_extensions = ext',
      'prompt = no',
      '[dn]',
      'CN = transfer-smoke',
      '[ext]',
      'subjectAltName = DNS:localhost, IP:127.0.0.1',
      'basicConstraints = critical,CA:true',
    ].join('\n'),
  )
  const made = spawnSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1'].concat([
      '-keyout',
      key,
      '-out',
      cert,
      '-config',
      cnf,
    ]),
    { encoding: 'utf8' },
  )
  if (made.status !== 0) throw new Error(`openssl could not make a certificate: ${made.stderr}`)
  return { key: readFileSync(key), cert: readFileSync(cert), certFile: cert }
}

function listen(server, port = 0) {
  return new Promise((ready) =>
    server.listen(port, '127.0.0.1', () => ready(server.address().port)),
  )
}

async function freePort() {
  const probe = createServer()
  const port = await listen(probe)
  await new Promise((closed) => probe.close(closed))
  return port
}

async function bodyOf(req) {
  let text = ''
  for await (const piece of req) text += piece
  return text
}

/** The fake provider's own answers, over https, plus the browser's leg: /authorize redirects back. */
async function serveIdentityProvider(tls, clientId) {
  const server = createHttpsServer(tls)
  const port = await listen(server)
  const issuer = `https://127.0.0.1:${port}`
  const provider = await fakeOidcProvider(issuer, clientId)
  server.on('request', async (req, res) => {
    const url = new URL(req.url, issuer)
    if (url.pathname === '/authorize') {
      res.writeHead(302, { location: provider.authorize(url.toString()) }).end()
      return
    }
    const answer = await provider.fetch(url.toString(), {
      method: req.method,
      body: req.method === 'POST' ? await bodyOf(req) : undefined,
    })
    res.writeHead(answer.status, Object.fromEntries(answer.headers)).end(await answer.text())
  })
  return { issuer, provider, close: () => server.close() }
}

/** TLS in front of the keeper, as every server-mode deployment has. */
async function serveTlsProxy(tls, upstreamPort) {
  const server = createHttpsServer(tls, (req, res) => {
    const upstream = request(
      {
        host: '127.0.0.1',
        port: upstreamPort,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (answer) => {
        res.writeHead(answer.statusCode, answer.headers)
        answer.pipe(res)
      },
    )
    upstream.on('error', () => res.writeHead(502).end())
    req.pipe(upstream)
  })
  return { port: await listen(server), close: () => server.close() }
}

/** The `/*` block of the build's `_headers`: what its hosting sends with every page. */
function hostingHeaders() {
  const headers = {}
  let inBlock = false
  for (const line of readFileSync(join(WEB_DIST, '_headers'), 'utf8').split('\n')) {
    if (!line.startsWith(' ')) inBlock = line.trim() === '/*'
    else if (inBlock && line.includes(':')) {
      const at = line.indexOf(':')
      headers[line.slice(0, at).trim()] = line.slice(at + 1).trim()
    }
  }
  return headers
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
}

/** The browser-mode app, with its hosting's single-page fallback. */
async function serveBrowserApp() {
  const headers = hostingHeaders()
  const server = createServer((req, res) => {
    const path = join(WEB_DIST, decodeURIComponent(new URL(req.url, 'http://x').pathname))
    const file =
      path.startsWith(WEB_DIST) && existsSync(path) && statSync(path).isFile()
        ? path
        : join(WEB_DIST, 'index.html')
    res.writeHead(200, {
      ...headers,
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    })
    res.end(readFileSync(file))
  })
  return { origin: `http://127.0.0.1:${await listen(server)}`, close: () => server.close() }
}

/** `whiteboard server run` from the built dist; resolves once it prints its ready line. */
function startKeeper({ port, publicOrigin, idp, signInConfig, caFile, dataDir }) {
  const keeper = spawn(
    process.execPath,
    [
      CLI,
      'server',
      'run',
      '--json',
      `--external-url=${publicOrigin}`,
      '--auth-strategy=oauth-jwt',
      `--jwt-issuer=${idp.issuer}`,
      `--jwt-audience=${publicOrigin}`,
      `--jwks-uri=${idp.issuer}/jwks`,
      '--host=127.0.0.1',
      `--port=${port}`,
      `--data-dir=${dataDir}`,
    ],
    {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: {
        // The built dist is what runs; WHITEBOARD_DEV would send it to src/.
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'WHITEBOARD_DEV')),
        WHITEBOARD_SIGN_IN_CONFIG: signInConfig,
        TRANSFER_SMOKE_CLIENT_SECRET: 'transfer-smoke-client-secret',
        // The keeper's relying party reaches the provider over https.
        NODE_EXTRA_CA_CERTS: caFile,
      },
    },
  )
  return new Promise((ready, fail) => {
    keeper.stdout.once('data', () => ready(keeper))
    keeper.once('exit', (code) =>
      fail(new Error(`the keeper exited (${code}) before it was ready`)),
    )
  })
}

async function stopKeeper(keeper) {
  if (keeper === undefined || keeper.exitCode !== null) return
  keeper.kill('SIGTERM')
  await new Promise((exited) => keeper.once('exit', exited))
}

/** Sign in at B through the provider, as a person does: B's page, a redirect, and back. */
async function signIn(page, keeperOrigin) {
  await page.goto(`${keeperOrigin}/sign-in`)
  await page.getByRole('link', { name: /Continue with/ }).click()
  await page.getByText(`Signed in as ${PERSON.name}`).waitFor({ timeout: WAIT_MS })
}

function appears(locator) {
  return locator
    .waitFor({ timeout: WAIT_MS })
    .then(() => true)
    .catch(() => false)
}

function textOf(locator) {
  return locator.innerText({ timeout: 1_000 }).catch((err) => String(err))
}

/** Same-origin requests at B, carrying the signed-in person's session. */
function keeperApi(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: res.status, json: await res.json().catch(() => null) }
    },
    { method, path, body },
  )
}

/** Settings > Connections at A, the keeper's address, Send: answers the window it opened. */
async function sendFromBrowserApp(page, browserOrigin, keeperOrigin) {
  await page.goto(`${browserOrigin}/settings`)
  await page.getByRole('link', { name: 'Connections' }).first().click()
  await page.getByTestId('transfer-keeper-address').fill(keeperOrigin)
  const opened = page.waitForEvent('popup', { timeout: WAIT_MS })
  await page.getByTestId('transfer-send').click()
  const popup = await opened
  await popup.waitForLoadState()
  return popup
}

const tls = selfSignedCertificate()
const clientId = 'transfer-smoke-client'
const idp = await serveIdentityProvider(tls, clientId)
const keeperPort = await freePort()
const proxy = await serveTlsProxy(tls, keeperPort)
const keeperOrigin = `https://localhost:${proxy.port}`
const browserApp = await serveBrowserApp()
const signInConfig = join(scratch, 'sign-in.json')
writeFileSync(
  signInConfig,
  JSON.stringify({
    providers: [
      {
        id: 'smoke-idp',
        kind: 'oidc',
        issuer: idp.issuer,
        clientId,
        clientSecret: { env: 'TRANSFER_SMOKE_CLIENT_SECRET' },
        displayName: 'Smoke IdP',
        admission: { createAccounts: true },
      },
    ],
  }),
)
idp.provider.next({ sub: PERSON.sub, name: PERSON.name })

let keeper
const browser = await chromium.launch({
  headless: true,
  ...(process.env.WHITEBOARD_CHROME_PATH && { executablePath: process.env.WHITEBOARD_CHROME_PATH }),
})
try {
  keeper = await startKeeper({
    port: keeperPort,
    publicOrigin: keeperOrigin,
    idp,
    signInConfig,
    caFile: tls.certFile,
    dataDir: join(scratch, 'keeper-data'),
  })
  // The self-signed certificate is this run's; the browser is told to accept it.
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const keeperPage = await context.newPage()
  const appPage = await context.newPage()

  await signIn(keeperPage, keeperOrigin)
  const created = await keeperApi(keeperPage, 'POST', '/api/workspaces', {
    displayName: 'Receiving',
  })
  const workspaceId = created.json?.workspaceId
  check(
    created.status === 201,
    'a signed-in person creates a workspace at B',
    JSON.stringify(created),
  )
  const documentsAtB = async () =>
    (await keeperApi(keeperPage, 'GET', `/api/workspaces/${workspaceId}/documents`)).json

  // A note in A's browser workspace.
  await appPage.goto(`${browserApp.origin}/`)
  await appPage.getByRole('button', { name: 'Create a markdown note' }).click()
  await appPage.getByPlaceholder('Title').fill(NOTE_TITLE)
  await appPage.locator('.cm-content').click()
  await appPage.keyboard.type('carried across origins')

  // --- The control: signed out at B. ---
  await keeperPage.goto(`${keeperOrigin}/`)
  await keeperPage.getByRole('button', { name: 'Sign out' }).click()
  await keeperPage.waitForURL(/\/sign-in/, { timeout: WAIT_MS })
  {
    const popup = await sendFromBrowserApp(appPage, browserApp.origin, keeperOrigin)
    check(
      await appears(popup.getByTestId('receive-transfer-sign-in')),
      'signed out, the transfer window says to sign in',
      await textOf(popup.locator('main')),
    )
    const accept = popup.getByTestId('receive-transfer-accept')
    check(
      (await accept.count()) === 1 && (await accept.isDisabled()),
      'signed out, Accept is disabled',
      `${await accept.count()} Accept control(s)`,
    )
    await popup.close()
  }

  await signIn(keeperPage, keeperOrigin)
  const before = await documentsAtB()
  check(
    Array.isArray(before?.documents) && before.documents.length === 0,
    'signed out, nothing was merged at B',
    JSON.stringify(before),
  )

  // --- The transfer: signed in at B. ---
  {
    const popup = await sendFromBrowserApp(appPage, browserApp.origin, keeperOrigin)
    const at = new URL(popup.url())
    check(
      at.origin === keeperOrigin && at.pathname === '/receive-transfer',
      "the window opens at B's /receive-transfer",
      popup.url(),
    )
    // The offer only arrives if the window could announce itself to its
    // opener, so this is where a severed `window.opener` shows.
    const offered = await appears(popup.getByTestId('receive-transfer-offer'))
    check(
      offered,
      'the window hears its opener: the offer arrives',
      await textOf(popup.locator('main')),
    )
    if (offered) {
      await popup.getByTestId('receive-transfer-accept').click()
      check(
        await appears(popup.getByTestId('receive-transfer-done')),
        'Accept merges at B',
        await textOf(popup.locator('main')),
      )
    }
    const report = appPage.getByTestId('transfer-report')
    check(
      await appears(report.filter({ hasText: 'Sent 1 document.' })),
      'the sender reports the transfer',
      await textOf(report),
    )
  }

  const after = await documentsAtB()
  check(
    after?.documents?.some((d) => d.name === NOTE_TITLE) === true,
    "B's own API lists the transferred note",
    JSON.stringify(after),
  )
} catch (err) {
  check(false, 'the run completed', err instanceof Error ? err.stack : String(err))
} finally {
  await browser.close()
  await stopKeeper(keeper)
  proxy.close()
  idp.close()
  browserApp.close()
  rmSync(scratch, { recursive: true, force: true })
}

if (failed) {
  console.error(`${LABEL} FAIL`)
  process.exit(1)
}
console.log(`${LABEL} ok`)
