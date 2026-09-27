/**
 * `whiteboard native-host` end to end, the way a browser meets it: `install`
 * writes a launcher, and the browser runs that launcher from a directory of
 * its own choosing, speaking framed JSON on stdio. Its stdout is the protocol
 * channel, so a stray line of text there would break every message after it.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type HostToPage,
  hostToPageSchema,
} from '@kamiazya/whiteboard-daemon-client/extension-bridge'
import { NATIVE_HOST_NAME } from '@kamiazya/whiteboard-daemon-client/extension-names'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeNativeMessage, readNativeMessages } from '../daemon/native-host/native-messaging.js'

const MCP_SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const CLI_SOURCE = join(MCP_SERVER_DIR, 'src/cli/index.ts')

let scratch: string
let daemon: Server | undefined
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'wb-native-host-cli-'))
})
afterEach(async () => {
  daemon?.closeAllConnections()
  await new Promise<void>((done) => (daemon ? daemon.close(() => done()) : done()))
  daemon = undefined
  rmSync(scratch, { recursive: true, force: true })
})

describe('whiteboard native-host', () => {
  it('installs a launcher the browser can start from anywhere, relaying to the daemon', async () => {
    const dataDir = join(scratch, 'data')
    const manifestDir = join(scratch, 'NativeMessagingHosts')
    const installed = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx/esm',
        CLI_SOURCE,
        'native-host',
        'install',
        '--json',
        `--data-dir=${dataDir}`,
        `--manifest-dir=${manifestDir}`,
      ],
      { cwd: MCP_SERVER_DIR, encoding: 'utf8' },
    )
    expect(installed.status, installed.stderr).toBe(0)
    const result = JSON.parse(installed.stdout)
    const manifest = JSON.parse(readFileSync(join(manifestDir, `${NATIVE_HOST_NAME}.json`), 'utf8'))
    expect(manifest.path).toBe(result.launcher)

    const socketPath = join(scratch, 'd.sock')
    let authorization: string | undefined
    daemon = createServer((req, res) => {
      authorization = req.headers.authorization
      res.end('pong')
    })
    await new Promise<void>((done) => daemon?.listen(socketPath, done))
    writeFileSync(
      join(dataDir, 'daemon.json'),
      JSON.stringify({
        pid: process.pid,
        port: 1,
        version: 't',
        startedAt: 't',
        token: 'tkn',
        socketPath,
      }),
    )

    const host = spawn(manifest.path, ['chrome-extension://whatever/'], {
      cwd: tmpdir(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const received: HostToPage[] = []
    void readNativeMessages(host.stdout, (m) => received.push(hostToPageSchema.parse(m)))
    host.stdin.write(
      encodeNativeMessage({
        type: 'request',
        id: 'p',
        method: 'GET',
        path: '/api/runtime/ping',
        headers: {},
      }),
    )
    await vi.waitFor(() => expect(received.some((m) => m.type === 'end')).toBe(true), {
      timeout: 15_000,
    })
    host.stdin.end()
    await new Promise((done) => host.once('exit', done))

    expect(authorization).toBe('Bearer tkn')
    const body = received.flatMap((m) =>
      m.type === 'chunk' ? [Buffer.from(m.data, 'base64')] : [],
    )
    expect(Buffer.concat(body).toString()).toBe('pong')
  }, 30_000)
})
