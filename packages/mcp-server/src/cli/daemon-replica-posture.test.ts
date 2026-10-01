import { describe, expect, it, vi } from 'vitest'
import type { DaemonRecordParseResult } from '../daemon/daemon-record.js'
import {
  type DaemonRequest,
  runDaemonRotateReplicaKey,
  runDaemonSetReplicaTier,
} from './daemon-replica-posture.js'

const record = {
  pid: 4242,
  version: '0.0.1',
  startedAt: '2026-01-01T00:00:00.000Z',
  socketPath: '/tmp/wb.sock',
  token: 'the-daemon-token',
}
const running: DaemonRecordParseResult = { kind: 'ok', record }

/** A daemon that answers one canned response, recording what it was asked. */
function daemonAnswering(status: number, body: unknown) {
  const asked: DaemonRequest[] = []
  const request = vi.fn(async (req: DaemonRequest) => {
    asked.push(req)
    return { status, body }
  })
  return { request, asked }
}

const KEY_ID = 'AAAAAAAAAAAAAAAAAAAAAA'

describe('whiteboard daemon rotate-replica-key', () => {
  it('asks the running daemon over its socket, under its token, and reports the new keyId', async () => {
    const daemon = daemonAnswering(200, { keyId: KEY_ID })
    const { result, exitCode } = await runDaemonRotateReplicaKey({
      dataDir: '/data',
      workspaceId: 'ws-1',
      parseRecord: async () => running,
      isPidAlive: () => true,
      request: daemon.request,
    })
    expect(exitCode).toBe(0)
    expect(result).toEqual({
      schemaVersion: 1,
      ok: true,
      workspaceId: 'ws-1',
      keyId: KEY_ID,
    })
    expect(daemon.asked).toEqual([
      {
        record,
        method: 'POST',
        path: '/api/workspaces/ws-1/replica-key/rotate',
      },
    ])
  })

  it('answers daemon-not-running without asking anything when no daemon is up', async () => {
    const daemon = daemonAnswering(200, { keyId: KEY_ID })
    const { result, exitCode } = await runDaemonRotateReplicaKey({
      dataDir: '/data',
      workspaceId: 'ws-1',
      parseRecord: async () => ({ kind: 'missing' }),
      isPidAlive: () => true,
      request: daemon.request,
    })
    expect(exitCode).toBe(1)
    expect(result).toEqual({
      schemaVersion: 1,
      ok: false,
      workspaceId: 'ws-1',
      reason: 'daemon-not-running',
      message: 'no daemon record found under the data directory',
    })
    expect(daemon.asked).toEqual([])
  })

  it('treats a record whose process is gone as no daemon', async () => {
    const daemon = daemonAnswering(200, { keyId: KEY_ID })
    const { result } = await runDaemonRotateReplicaKey({
      dataDir: '/data',
      workspaceId: 'ws-1',
      parseRecord: async () => running,
      isPidAlive: () => false,
      request: daemon.request,
    })
    expect(result).toMatchObject({ ok: false, reason: 'daemon-not-running' })
    expect(daemon.asked).toEqual([])
  })

  it("reports the daemon's refusal with its status and reason, exit 1", async () => {
    const daemon = daemonAnswering(404, {
      error: 'unknown_workspace',
      title: 'Workspace not found',
    })
    const { result, exitCode } = await runDaemonRotateReplicaKey({
      dataDir: '/data',
      workspaceId: 'nope',
      parseRecord: async () => running,
      isPidAlive: () => true,
      request: daemon.request,
    })
    expect(exitCode).toBe(1)
    expect(result).toEqual({
      schemaVersion: 1,
      ok: false,
      workspaceId: 'nope',
      reason: 'refused',
      status: 404,
      message: 'Workspace not found',
    })
  })

  it("reports the daemon's sentence, not its code, when the refusal carries both", async () => {
    const daemon = daemonAnswering(404, {
      error: 'unknown_workspace',
      message: 'Workspace "nope" is not one this daemon holds.',
    })
    const { result } = await runDaemonRotateReplicaKey({
      dataDir: '/data',
      workspaceId: 'nope',
      parseRecord: async () => running,
      isPidAlive: () => true,
      request: daemon.request,
    })
    expect(result).toMatchObject({
      reason: 'refused',
      message: 'Workspace "nope" is not one this daemon holds.',
    })
  })

  it('refuses a 2xx whose body is not the rotate contract rather than inventing a keyId', async () => {
    const daemon = daemonAnswering(200, { keyId: 'short' })
    const { result, exitCode } = await runDaemonRotateReplicaKey({
      dataDir: '/data',
      workspaceId: 'ws-1',
      parseRecord: async () => running,
      isPidAlive: () => true,
      request: daemon.request,
    })
    expect(exitCode).toBe(1)
    expect(result).toMatchObject({ ok: false, reason: 'malformed-response', status: 200 })
  })
})

describe('whiteboard daemon set-replica-tier', () => {
  it('PUTs the tier and echoes what the daemon resolved it to', async () => {
    const daemon = daemonAnswering(200, { tier: 'bounded', effectiveTier: 'bounded' })
    const { result, exitCode } = await runDaemonSetReplicaTier({
      dataDir: '/data',
      workspaceId: 'ws-1',
      tier: 'bounded',
      parseRecord: async () => running,
      isPidAlive: () => true,
      request: daemon.request,
    })
    expect(exitCode).toBe(0)
    expect(result).toEqual({
      schemaVersion: 1,
      ok: true,
      workspaceId: 'ws-1',
      tier: 'bounded',
      effectiveTier: 'bounded',
    })
    expect(daemon.asked).toEqual([
      {
        record,
        method: 'PUT',
        path: '/api/workspaces/ws-1/replica-tier',
        body: { tier: 'bounded' },
      },
    ])
  })

  it('clears the override with tier null and reports the default it falls back to', async () => {
    const daemon = daemonAnswering(200, { tier: null, effectiveTier: 'offline' })
    const { result } = await runDaemonSetReplicaTier({
      dataDir: '/data',
      workspaceId: 'ws-1',
      tier: null,
      parseRecord: async () => running,
      isPidAlive: () => true,
      request: daemon.request,
    })
    expect(result).toMatchObject({ ok: true, tier: null, effectiveTier: 'offline' })
    expect(daemon.asked[0]?.body).toEqual({ tier: null })
  })
})
