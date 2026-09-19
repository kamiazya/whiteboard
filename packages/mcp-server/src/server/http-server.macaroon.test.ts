import { request } from 'node:http'
import {
  DAEMON_TOKEN_WS_PROTOCOL_PREFIX,
  WHITEBOARD_WS_PROTOCOL,
} from '@kamiazya/whiteboard-daemon-client/ws-protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { findAvailablePort } from '../cli/daemon-run.js'
import { getDataDir } from '../shared/data-dir-secure.js'
import { type RunningServer, startHttpServer } from './http-server.js'
import { mintMacaroon } from './security/macaroon.js'
import { createMacaroonRootKey } from './security/macaroon-root-key.js'

// The reachability test for ADR-0043's act plane, and the one the unit tests
// structurally cannot be.
//
// `auth.macaroon.test.ts` and `ws-auth.macaroon.test.ts` hand the root key to
// the middleware directly, so they pass whether or not the composition root
// ever supplies one. That is exactly what happened: `createMacaroonRootKey`
// shipped with no production caller and neither `createApp` nor the upgrade
// listener passed `macaroonRootKey`, so every macaroon reaching the real
// daemon got a 401 while 20 unit tests reported the feature working. Review
// caught it; nothing in the suite could have.
//
// This file starts the REAL server and reaches it over a real socket, the way
// `startHttpServer ws-ticket mint→upgrade wiring` does for the same class of
// bug — a feature wired to two different instances, or to none.
//
// It reads the key back through `createMacaroonRootKey`, which is load-or-
// create: after the server has started, that returns the SAME key the server
// holds. A test that minted its own key instead would prove only that the
// module works.

let nextPortBase = 4700
async function acquirePort(): Promise<number> {
  const port = await findAvailablePort(nextPortBase)
  nextPortBase = port + 1
  return port
}

const DAEMON_TOKEN = 'the-daemon-token-for-macaroon-wiring'
const READ_PATH = '/api/w/ws-alpha/document/board'

describe('startHttpServer macaroon wiring (ADR-0043)', () => {
  let running: RunningServer | undefined

  afterEach(async () => {
    await running?.close()
    running = undefined
  })

  it('admits a macaroon minted under the daemon’s own root key, and refuses one caveated below the route', async () => {
    const port = await acquirePort()
    running = await startHttpServer({ port, host: '127.0.0.1', token: DAEMON_TOKEN })

    // Load-or-create against the same data dir: the server has already run,
    // so this reads the key it is verifying against rather than making one.
    const { rootKey } = createMacaroonRootKey({ dataDir: getDataDir() })

    const readToken = await mintMacaroon({
      rootKey,
      tokenId: 'wiring-read',
      caveats: [{ kind: 'scope', scopes: ['canvas:read'] }],
    })
    const get = (bearer: string) =>
      fetch(`http://127.0.0.1:${port}${READ_PATH}`, {
        headers: { authorization: `Bearer ${bearer}` },
      })

    // The route answers 200 or 404 depending on whether the document exists;
    // either means the GUARD let it through, which is what this asserts. A
    // 401 is the failure this test exists to catch.
    const admitted = await get(readToken)
    expect(admitted.status).not.toBe(401)

    const writeOnlyElsewhere = await mintMacaroon({
      rootKey,
      tokenId: 'wiring-narrow',
      caveats: [{ kind: 'scope', scopes: ['versions:read'] }],
    })
    expect((await get(writeOnlyElsewhere)).status).toBe(401)
  })

  it('refuses a macaroon minted under a key the daemon does not hold', async () => {
    const port = await acquirePort()
    running = await startHttpServer({ port, host: '127.0.0.1', token: DAEMON_TOKEN })

    const foreign = await mintMacaroon({
      rootKey: new Uint8Array(32).fill(1),
      tokenId: 'wiring-foreign',
      caveats: [{ kind: 'scope', scopes: ['canvas:read'] }],
    })

    const response = await fetch(`http://127.0.0.1:${port}${READ_PATH}`, {
      headers: { authorization: `Bearer ${foreign}` },
    })

    expect(response.status).toBe(401)
  })
})

function attemptWsUpgradeWithBearer(port: number, bearer: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path: '/ws/ws_test/canvas',
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Protocol': `${WHITEBOARD_WS_PROTOCOL}, ${DAEMON_TOKEN_WS_PROTOCOL_PREFIX}${bearer}`,
      },
    })
    req.on('upgrade', (res, socket) => {
      socket.destroy()
      resolve(res.statusCode ?? 0)
    })
    req.on('response', (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
}

// The websocket half of the same reachability gap, and it needed its own
// test: removing `macaroonRootKey` from the upgrade call left all eleven
// `ws-auth.macaroon.test.ts` cases green, because they pass the key in
// themselves. Measured while mutation-checking the HTTP half.
describe('startHttpServer macaroon WS upgrade wiring (ADR-0043)', () => {
  let running: RunningServer | undefined

  afterEach(async () => {
    await running?.close()
    running = undefined
  })

  it('admits a real upgrade offering a macaroon, and refuses one under a foreign key', async () => {
    const port = await acquirePort()
    running = await startHttpServer({ port, host: '127.0.0.1', token: DAEMON_TOKEN })
    const { rootKey } = createMacaroonRootKey({ dataDir: getDataDir() })

    const token = await mintMacaroon({
      rootKey,
      tokenId: 'wiring-ws',
      caveats: [{ kind: 'scope', scopes: ['canvas:read'] }],
    })
    await expect(attemptWsUpgradeWithBearer(port, token)).resolves.toBe(101)

    const foreign = await mintMacaroon({
      rootKey: new Uint8Array(32).fill(2),
      tokenId: 'wiring-ws-foreign',
      caveats: [{ kind: 'scope', scopes: ['canvas:read'] }],
    })
    await expect(attemptWsUpgradeWithBearer(port, foreign)).resolves.toBe(401)
  })
})
