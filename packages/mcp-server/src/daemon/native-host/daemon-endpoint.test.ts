import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { endpointProof } from '../../shared/endpoint-proof.js'
import { getDaemonRecordPath } from '../daemon-registry.js'
import { DaemonNoAnswerError, type DaemonRequest } from '../daemon-request.js'
import { resolveDaemonEndpoint } from './daemon-endpoint.js'

describe('resolveDaemonEndpoint', () => {
  let dataDir: string | undefined
  afterEach(async () => {
    if (dataDir !== undefined) await rm(dataDir, { recursive: true, force: true })
    dataDir = undefined
  })

  it('answers null when no daemon record exists', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'wb-native-host-'))
    await expect(resolveDaemonEndpoint(dataDir)).resolves.toBeNull()
  })

  it("rejects with the record reader's refusal, naming the record", async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'wb-native-host-'))
    const target = join(dataDir, 'elsewhere.json')
    await writeFile(target, '{}')
    await symlink(target, getDaemonRecordPath(dataDir))
    await expect(resolveDaemonEndpoint(dataDir)).rejects.toThrow(getDaemonRecordPath(dataDir))
  })

  // A daemon that crashed, was killed or lost its machine leaves its record
  // behind; relaying to its socket would answer a socket error where the
  // person needs "start one".
  async function writeRecord(dir: string, startedAt: string): Promise<string> {
    const socketPath = join(dir, 'gone.sock')
    const record = { pid: process.pid, version: '0.0.0', startedAt, socketPath, token: 't' }
    await writeFile(getDaemonRecordPath(dir), JSON.stringify(record))
    return socketPath
  }

  it('answers null for a valid record whose daemon is dead', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'wb-native-host-'))
    await writeRecord(dataDir, new Date().toISOString())
    await expect(resolveDaemonEndpoint(dataDir, { isAlive: () => false })).resolves.toBeNull()
  })

  it('answers null for a valid record whose pid another process took', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'wb-native-host-'))
    await writeRecord(dataDir, new Date().toISOString())
    const seams = { isAlive: () => true, startMs: () => Date.now() + 60_000 }
    await expect(resolveDaemonEndpoint(dataDir, seams)).resolves.toBeNull()
  })

  // Relaying under the record's token to whatever holds the socket would send a
  // request to a daemon the record does not describe.
  it('refuses a record whose socket answers as another pid, naming that pid', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'wb-native-host-'))
    await writeRecord(dataDir, new Date().toISOString())
    const seams = {
      isAlive: () => true,
      startMs: () => Date.now() + 60_000,
      request: async () => ({ status: 200, body: { pid: process.pid + 1 } }),
    }
    await expect(resolveDaemonEndpoint(dataDir, seams)).rejects.toThrow(
      `as pid ${process.pid + 1}, not as pid ${process.pid}`,
    )
  })

  it('refuses a record whose socket takes the connection and stays silent', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'wb-native-host-'))
    await writeRecord(dataDir, new Date().toISOString())
    const seams = {
      isAlive: () => true,
      startMs: () => Date.now() + 60_000,
      request: async () => {
        throw new DaemonNoAnswerError('no answer within 1500ms')
      },
    }
    await expect(resolveDaemonEndpoint(dataDir, seams)).rejects.toThrow(
      getDaemonRecordPath(dataDir),
    )
  })

  it('relays to a valid record whose daemon is still running', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'wb-native-host-'))
    const socketPath = await writeRecord(dataDir, new Date().toISOString())
    const seams = { isAlive: () => true, startMs: () => Date.now() - 60_000 }
    await expect(resolveDaemonEndpoint(dataDir, seams)).resolves.toEqual({ socketPath, token: 't' })
  })

  // Windows: no /proc, so a live pid says nothing about who wrote the record,
  // and a pipe name a crashed daemon released can be re-created by any user.
  describe('on a named pipe whose start time cannot be read', () => {
    const PIPE = '\\\\.\\pipe\\whiteboard-0123456789abcdef0123456789abcdef'
    const windowsShape = { isAlive: () => true, startMs: () => null }

    async function writePipeRecord(dir: string): Promise<void> {
      const record = {
        pid: process.pid,
        version: '0.0.0',
        startedAt: new Date().toISOString(),
        socketPath: PIPE,
        token: 't',
      }
      await writeFile(getDaemonRecordPath(dir), JSON.stringify(record))
    }

    it('refuses a pipe server that cannot prove it holds the token', async () => {
      dataDir = await mkdtemp(join(tmpdir(), 'wb-native-host-'))
      await writePipeRecord(dataDir)
      const asked: DaemonRequest[] = []
      const request = async (req: DaemonRequest) => {
        asked.push(req)
        return { status: 200, body: { proof: 'forged' } }
      }
      await expect(resolveDaemonEndpoint(dataDir, { ...windowsShape, request })).rejects.toThrow(
        getDaemonRecordPath(dataDir),
      )
      expect(asked.length).toBeGreaterThan(0)
      expect(asked.every((req) => req.record.token === undefined)).toBe(true)
    })

    it('relays to a pipe server that proves it holds the token', async () => {
      dataDir = await mkdtemp(join(tmpdir(), 'wb-native-host-'))
      await writePipeRecord(dataDir)
      const request = async (req: DaemonRequest) => {
        const nonce = new URL(req.path, 'http://daemon').searchParams.get('nonce') ?? ''
        expect(req.record.token).toBeUndefined()
        return { status: 200, body: { proof: await endpointProof('t', nonce) } }
      }
      await expect(resolveDaemonEndpoint(dataDir, { ...windowsShape, request })).resolves.toEqual({
        socketPath: PIPE,
        token: 't',
      })
    })

    it('answers null when nothing serves the recorded pipe', async () => {
      dataDir = await mkdtemp(join(tmpdir(), 'wb-native-host-'))
      await writePipeRecord(dataDir)
      const request = async () => {
        throw Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' })
      }
      await expect(resolveDaemonEndpoint(dataDir, { ...windowsShape, request })).resolves.toBeNull()
    })
  })
})
