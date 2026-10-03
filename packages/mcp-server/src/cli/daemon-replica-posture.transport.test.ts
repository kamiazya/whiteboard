/**
 * The REAL transport `daemon-replica-posture.ts` uses. `daemon-replica-posture.test.ts` injects
 * `request`, so the Bearer header, the JSON body and its length, and the status and non-JSON body
 * parsing run only here, against a throwaway HTTP server on a unix socket that plays the daemon.
 * The socket sits in the OS temp dir: a daemon refuses a socket path over 107 bytes.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DaemonRecordParseResult } from '../daemon/daemon-record.js'
import { runDaemonRotateReplicaKey, runDaemonSetReplicaTier } from './daemon-replica-posture.js'

const KEY_ID = 'AAAAAAAAAAAAAAAAAAAAAA'
let dir: string
let server: Server
let record: DaemonRecordParseResult
let seen: { method?: string; url?: string; headers: IncomingMessage['headers']; body: string }[]
let respond: (url: string, method: string) => { status: number; body: string }
let listing: { status: number; body: string }

const recordAt = (socketPath: string): DaemonRecordParseResult => ({
  kind: 'valid',
  record: {
    pid: process.pid,
    version: '0.0.1',
    startedAt: '2026-01-01T00:00:00.000Z',
    socketPath,
    token: 'the-daemon-token',
  },
})

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wb-posture-'))
  seen = []
  listing = { status: 200, body: JSON.stringify({ workspaces: [] }) }
  respond = () => ({ status: 200, body: JSON.stringify({ keyId: KEY_ID }) })
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      const out = req.url === '/api/workspaces' ? listing : respond(req.url ?? '', req.method ?? '')
      res.statusCode = out.status
      res.end(out.body)
    })
  })
  const socketPath = join(dir, 'd.sock')
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  record = recordAt(socketPath)
})
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve))
  await rm(dir, { recursive: true, force: true })
})

const options = () => ({
  dataDir: dir,
  workspaceId: 'ws-1',
  parseRecord: async () => record,
  isPidAlive: () => true,
})

describe('the daemon-replica-posture transport, over a real socket', () => {
  it('rotate: POSTs without a body, under the daemon token, and reports the key', async () => {
    const { result, exitCode } = await runDaemonRotateReplicaKey(options())
    expect(exitCode).toBe(0)
    expect(result).toMatchObject({ ok: true, keyId: KEY_ID })
    const post = seen.find((r) => r.method === 'POST')
    expect(post?.url).toBe('/api/workspaces/ws-1/replica-key/rotate')
    expect(post?.headers.authorization).toBe('Bearer the-daemon-token')
    expect(post?.headers['content-type']).toBeUndefined()
    expect(post?.body).toBe('')
  })

  it('set-tier: PUTs the tier as JSON with its length declared', async () => {
    respond = () => ({
      status: 200,
      body: JSON.stringify({ tier: 'offline', effectiveTier: 'offline' }),
    })
    const { result, exitCode } = await runDaemonSetReplicaTier({ ...options(), tier: 'offline' })
    expect(exitCode).toBe(0)
    expect(result).toMatchObject({ ok: true })
    const put = seen.find((r) => r.method === 'PUT')
    expect(put?.headers['content-type']).toBe('application/json')
    expect(put?.headers['content-length']).toBe(String(Buffer.byteLength(put?.body ?? '')))
    expect(JSON.parse(put?.body ?? 'null')).toEqual({ tier: 'offline' })
  })

  it('a refusal carries the daemon status, and a non-JSON body is reported as the text it was', async () => {
    respond = () => ({ status: 503, body: 'maintenance window' })
    const { result, exitCode } = await runDaemonRotateReplicaKey(options())
    expect(exitCode).toBe(1)
    expect(result).toMatchObject({
      ok: false,
      reason: 'refused',
      status: 503,
      message: 'maintenance window',
    })
  })

  it('an empty refusal body says what the daemon answered', async () => {
    respond = () => ({ status: 500, body: '' })
    const { result } = await runDaemonRotateReplicaKey(options())
    expect(result).toMatchObject({ ok: false, status: 500, message: 'the daemon answered 500' })
  })

  it('a 2xx outside the contract is malformed, not a success', async () => {
    respond = () => ({ status: 200, body: JSON.stringify({ unexpected: true }) })
    const { result } = await runDaemonRotateReplicaKey(options())
    expect(result).toMatchObject({ ok: false, reason: 'malformed-response' })
  })

  it('a socket nobody listens on is unreachable', async () => {
    record = recordAt(join(dir, 'gone.sock'))
    const { result, exitCode } = await runDaemonRotateReplicaKey(options())
    expect(exitCode).toBe(1)
    expect(result).toMatchObject({ ok: false, reason: 'unreachable' })
  })

  it('resolves the segment an operator typed to the canonical id the posture routes take', async () => {
    listing = {
      status: 200,
      body: JSON.stringify({
        workspaces: [{ workspaceId: '01M3YF14RXV2XXXXXXXXXXXXXX', segment: 'ws-1' }],
      }),
    }
    await runDaemonRotateReplicaKey(options())
    expect(seen.find((r) => r.method === 'POST')?.url).toBe(
      '/api/workspaces/01M3YF14RXV2XXXXXXXXXXXXXX/replica-key/rotate',
    )
  })

  it('passes the handle through as typed when the listing is not a 200', async () => {
    listing = {
      status: 500,
      body: JSON.stringify({
        workspaces: [{ workspaceId: '01M3YF14RXV2XXXXXXXXXXXXXX', segment: 'ws-1' }],
      }),
    }
    await runDaemonRotateReplicaKey(options())
    expect(seen.find((r) => r.method === 'POST')?.url).toBe(
      '/api/workspaces/ws-1/replica-key/rotate',
    )
  })

  it('treats a 3xx as a refusal, not a success', async () => {
    respond = () => ({ status: 300, body: JSON.stringify({ keyId: KEY_ID }) })
    const { result, exitCode } = await runDaemonRotateReplicaKey(options())
    expect(exitCode).toBe(1)
    expect(result).toMatchObject({ ok: false, reason: 'refused', status: 300 })
  })

  it('set-tier: a refusing daemon is reported as a refusal', async () => {
    respond = () => ({
      status: 403,
      body: JSON.stringify({ error: 'forbidden', reason: 'needs runtime:admin' }),
    })
    const { result, exitCode } = await runDaemonSetReplicaTier({ ...options(), tier: 'offline' })
    expect(exitCode).toBe(1)
    expect(result).toMatchObject({ ok: false, reason: 'refused', status: 403 })
  })
})
