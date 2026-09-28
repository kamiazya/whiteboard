import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { getDataDir } from '../shared/data-dir-secure.js'
import {
  claimIsolatedDataDir,
  releaseIsolatedDataDir,
} from '../shared/test-utils/isolated-data-dir.js'
import { socketFetch, testSocketPath } from '../shared/test-utils/socket-fetch.js'
import { type RunningServer, startHttpServer } from './http-server.js'
import { mintMacaroon } from './security/macaroon.js'
import { createMacaroonRootKey } from './security/macaroon-root-key.js'

// The reachability test for ADR-0043's act plane, and the one the unit tests
// structurally cannot be.
//
// `auth.macaroon.test.ts` hands the root key to the middleware directly, so
// it passes whether or not the composition root ever supplies one. That is
// exactly what happened once: `createMacaroonRootKey` shipped with no
// production caller, so every macaroon reaching the real daemon got a 401
// while the unit tests reported the feature working.
//
// This file starts the REAL server and reaches it over its real socket.
//
// It reads the key back through `createMacaroonRootKey`, which is load-or-
// create: after the server has started, that returns the SAME key the server
// holds. A test that minted its own key instead would prove only that the
// module works.

// A real server migrates whatever `getDataDir()` answers, and
// `http-server.test.ts` starts real servers too. Sharing the default dir with
// it means two worker processes migrating one sqlite file at once, which is
// how this file first turned that one red rather than itself.
let scratchDataDir: string
beforeAll(() => {
  scratchDataDir = claimIsolatedDataDir('macaroon-wiring')
})
afterAll(() => {
  releaseIsolatedDataDir(scratchDataDir)
})

const DAEMON_TOKEN = 'the-daemon-token-for-macaroon-wiring'
const READ_PATH = '/api/w/ws-alpha/document/board'

describe('startHttpServer macaroon wiring (ADR-0043)', () => {
  let running: RunningServer | undefined

  afterEach(async () => {
    await running?.close()
    running = undefined
  })

  it('admits a macaroon minted under the daemon’s own root key, and refuses one caveated below the route', async () => {
    const socketPath = testSocketPath()
    running = await startHttpServer({ socketPath, token: DAEMON_TOKEN })

    // Load-or-create against the same data dir: the server has already run,
    // so this reads the key it is verifying against rather than making one.
    const { rootKey } = createMacaroonRootKey({ dataDir: getDataDir() })

    const readToken = await mintMacaroon({
      rootKey,
      tokenId: 'wiring-read',
      caveats: [{ kind: 'scope', scopes: ['canvas:read'] }],
    })
    const get = (bearer: string) =>
      socketFetch(socketPath)(READ_PATH, { headers: { authorization: `Bearer ${bearer}` } })

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
    const socketPath = testSocketPath()
    running = await startHttpServer({ socketPath, token: DAEMON_TOKEN })

    const foreign = await mintMacaroon({
      rootKey: new Uint8Array(32).fill(1),
      tokenId: 'wiring-foreign',
      caveats: [{ kind: 'scope', scopes: ['canvas:read'] }],
    })

    const response = await socketFetch(socketPath)(READ_PATH, {
      headers: { authorization: `Bearer ${foreign}` },
    })

    expect(response.status).toBe(401)
  })
})
