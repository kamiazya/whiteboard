import {
  DAEMON_TOKEN_WS_PROTOCOL_PREFIX,
  WHITEBOARD_WS_PROTOCOL,
} from '@kamiazya/whiteboard-daemon-client/ws-protocol'
import { describe, expect, it } from 'vitest'
import { ALL_AUTH_SCOPES } from '../security/auth-strategy.js'
import { mintMacaroon } from '../security/macaroon.js'
import { authorizeWsUpgrade } from './ws-auth.js'

const ROOT_KEY = new Uint8Array(32).fill(5)
const OTHER_ROOT_KEY = new Uint8Array(32).fill(6)
const DAEMON_TOKEN = 'the-daemon-token'

const headers = (offered: string) => ({
  host: 'localhost:3099',
  'sec-websocket-protocol': `${WHITEBOARD_WS_PROTOCOL}, ${DAEMON_TOKEN_WS_PROTOCOL_PREFIX}${offered}`,
})

const upgrade = (offered: string, rootKey?: Uint8Array) =>
  authorizeWsUpgrade(headers(offered), DAEMON_TOKEN, [], undefined, undefined, rootKey)

describe('authorizeWsUpgrade — a macaroon carries its own scopes, not the full grant', () => {
  // The point of the slice. `ws.ts` already enforces per operation
  // (`hasRequiredScopes` on every text message and every binary update, over
  // `ws-scope-registry.ts`), so a narrower array here really does narrow what
  // the socket can do — it is not a value nobody reads.
  it('accepts a macaroon and grants exactly its caveated scopes', async () => {
    const token = await mintMacaroon({
      rootKey: ROOT_KEY,
      tokenId: 'agent-1',
      caveats: [{ kind: 'scope', scopes: ['canvas:read'] }],
    })

    const decision = await upgrade(token, ROOT_KEY)

    expect(decision.accept).toBe(true)
    expect(decision.scopes).toEqual(['canvas:read'])
    expect(decision.scopes).not.toEqual(ALL_AUTH_SCOPES)
  })

  it('grants a wider caveat set when the token carries one', async () => {
    const token = await mintMacaroon({
      rootKey: ROOT_KEY,
      tokenId: 'agent-1',
      caveats: [{ kind: 'scope', scopes: ['canvas:read', 'canvas:write'] }],
    })

    const decision = await upgrade(token, ROOT_KEY)

    expect(decision.scopes).toEqual(['canvas:read', 'canvas:write'])
  })

  it('refuses a macaroon minted under a different root key', async () => {
    const foreign = await mintMacaroon({
      rootKey: OTHER_ROOT_KEY,
      tokenId: 'agent-1',
      caveats: [{ kind: 'scope', scopes: ['canvas:read'] }],
    })

    expect(await upgrade(foreign, ROOT_KEY)).toEqual({ accept: false, statusCode: 401 })
  })

  it('refuses an expired macaroon', async () => {
    const expired = await mintMacaroon({
      rootKey: ROOT_KEY,
      tokenId: 'agent-1',
      caveats: [
        { kind: 'scope', scopes: ['canvas:read'] },
        { kind: 'expiresAt', epochMs: 0 },
      ],
    })

    expect(await upgrade(expired, ROOT_KEY)).toEqual({ accept: false, statusCode: 401 })
  })

  it('refuses a macaroon when the daemon was given no root key', async () => {
    const token = await mintMacaroon({
      rootKey: ROOT_KEY,
      tokenId: 'agent-1',
      caveats: [{ kind: 'scope', scopes: ['canvas:read'] }],
    })

    expect(await upgrade(token, undefined)).toEqual({ accept: false, statusCode: 401 })
  })
})

describe('authorizeWsUpgrade — what a macaroon must not change', () => {
  it('leaves the daemon token granting every scope', async () => {
    const decision = await upgrade(DAEMON_TOKEN, ROOT_KEY)

    expect(decision.accept).toBe(true)
    expect(decision.scopes).toEqual(ALL_AUTH_SCOPES)
  })

  it('still refuses a wrong token with a root key configured', async () => {
    expect(await upgrade('not-the-token', ROOT_KEY)).toEqual({ accept: false, statusCode: 401 })
  })

  it('still rejects a non-loopback Host before looking at any credential', async () => {
    const token = await mintMacaroon({
      rootKey: ROOT_KEY,
      tokenId: 'agent-1',
      caveats: [{ kind: 'scope', scopes: ['canvas:read'] }],
    })

    const decision = await authorizeWsUpgrade(
      { ...headers(token), host: 'evil.example.com:3099' },
      DAEMON_TOKEN,
      [],
      undefined,
      undefined,
      ROOT_KEY,
    )

    expect(decision).toEqual({ accept: false, statusCode: 403 })
  })

  // A macaroon offered without the base protocol must be refused for the same
  // reason a ticket is: a malformed upgrade is rejected before any credential
  // work, so nothing is spent on it.
  it('refuses a macaroon offered without the base subprotocol', async () => {
    const token = await mintMacaroon({
      rootKey: ROOT_KEY,
      tokenId: 'agent-1',
      caveats: [{ kind: 'scope', scopes: ['canvas:read'] }],
    })

    const decision = await authorizeWsUpgrade(
      {
        host: 'localhost:3099',
        'sec-websocket-protocol': `${DAEMON_TOKEN_WS_PROTOCOL_PREFIX}${token}`,
      },
      DAEMON_TOKEN,
      [],
      undefined,
      undefined,
      ROOT_KEY,
    )

    expect(decision).toEqual({ accept: false, statusCode: 401 })
  })
})
