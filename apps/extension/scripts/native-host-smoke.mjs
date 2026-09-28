// The native host with no browser in front of it: a real daemon on its
// socket (a named pipe on Windows), the host `whiteboard native-host install`
// writes, started the way a browser starts it, and one request spoken in the
// native messaging framing. It is the part of ADR-0050's bridge a Windows
// runner can check without a browser, and the same script runs everywhere.
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { createSmoke, startDaemon, stopDaemon, whiteboard } from './smoke-kit.mjs'

const windows = process.platform === 'win32'
const smoke = createSmoke('native-host-smoke')
const { check, dataDir, scratch } = smoke

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length)
  return Buffer.concat([head, body])
}

/** Starts the launcher as a browser does, sends one request, answers what came back. */
function relay(launcher, request) {
  // A browser starts a .cmd host through cmd; so does this.
  const host = windows
    ? spawn('cmd.exe', ['/d', '/s', '/c', `"${launcher}" chrome-extension://smoke/`], {
        windowsVerbatimArguments: true,
      })
    : spawn(launcher, ['chrome-extension://smoke/'])
  const replies = []
  let pending = Buffer.alloc(0)
  return new Promise((done, fail) => {
    const timer = setTimeout(() => {
      host.kill()
      fail(new Error(`no end within 20s; heard ${JSON.stringify(replies)}`))
    }, 20_000)
    host.stdout.on('data', (piece) => {
      pending = Buffer.concat([pending, piece])
      while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32LE(0)) {
        const length = pending.readUInt32LE(0)
        const reply = JSON.parse(pending.subarray(4, 4 + length).toString('utf8'))
        pending = pending.subarray(4 + length)
        replies.push(reply)
        if (reply.type === 'end' || reply.type === 'error') {
          clearTimeout(timer)
          host.stdin.end()
          done(replies)
        }
      }
    })
    host.stderr.on('data', (piece) => process.stderr.write(piece))
    host.once('error', fail)
    host.stdin.write(frame(request))
  })
}

let daemon
try {
  const started = await startDaemon(dataDir)
  daemon = started.daemon
  const socketPath = started.record.socketPath ?? ''
  check(
    windows ? /^\\\\\.\\pipe\\whiteboard-[0-9a-f]{32}$/.test(socketPath) : socketPath !== '',
    windows ? 'the daemon listens on a named pipe' : 'the daemon records its socket',
    socketPath,
  )

  // Linux and macOS read manifests from browser directories, so point it at
  // one here; Windows registers each browser's key and needs no directory.
  const installed = whiteboard([
    'native-host',
    'install',
    '--json',
    `--data-dir=${dataDir}`,
    ...(windows ? [] : [`--manifest-dir=${join(scratch, 'NativeMessagingHosts')}`]),
  ])
  check(installed.ok === true, 'the host installs', JSON.stringify(installed))

  if (windows) {
    const manifest = installed.manifests.find((m) => m.browser === 'chrome')
    const query = spawnSync(
      'reg',
      [
        'query',
        'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\io.github.kamiazya.whiteboard',
        '/ve',
      ],
      { encoding: 'utf8' },
    )
    check(
      query.status === 0 && manifest !== undefined && query.stdout.includes(join(manifest.dir, '')),
      "Chrome's registry key names the manifest",
      `${query.status} ${query.stdout}${query.stderr}`,
    )
  }

  const replies = await relay(installed.launcher, {
    type: 'request',
    id: 'smoke-1',
    method: 'GET',
    path: '/api/workspaces',
    headers: { accept: 'application/json' },
  })
  const head = replies.find((r) => r.type === 'head')
  check(
    head?.status === 200,
    'a request through the host reaches the daemon and is answered',
    JSON.stringify(replies).slice(0, 400),
  )
} catch (err) {
  check(false, 'the smoke ran to the end', err instanceof Error ? err.message : String(err))
} finally {
  await stopDaemon(daemon)
  smoke.finish()
}
