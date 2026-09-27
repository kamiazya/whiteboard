/**
 * ADR-0050 decision 2: where the daemon's local socket lives, and how a place
 * for it is made safe.
 *
 * The socket is what an owner-only boundary rests on, so its DIRECTORY has to
 * be the owner's alone: a socket file's own mode is honoured on Linux but not
 * everywhere, while a directory others cannot enter keeps them out on every
 * Unix. The per-user runtime directory is that already; the temp-dir
 * fallback is a directory we create and then refuse unless it is ours and
 * closed.
 *
 * A Unix socket path is limited to 104 bytes on macOS and 108 on Linux, so
 * the file is named by a hash of the data dir rather than by the data dir.
 */
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createAdaptorServer } from '@hono/node-server'

interface SocketPathContext {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly platform: NodeJS.Platform
  readonly uid: number
  readonly tmp?: string
}

function defaultContext(): SocketPathContext {
  return { env: process.env, platform: process.platform, uid: process.getuid?.() ?? -1 }
}

/**
 * The socket for the daemon keeping `dataDir`, or null where the platform has
 * none yet. Windows takes a named pipe, which ADR-0050 measures before
 * building.
 */
export function daemonSocketPath(
  dataDir: string,
  context: SocketPathContext = defaultContext(),
): string | null {
  if (context.platform === 'win32') return null
  const name = `${createHash('sha256').update(resolve(dataDir)).digest('hex').slice(0, 16)}.sock`
  const runtime = context.env.XDG_RUNTIME_DIR
  if (runtime !== undefined && runtime !== '') return join(runtime, 'whiteboard', name)
  return join(context.tmp ?? tmpdir(), `whiteboard-${context.uid}`, name)
}

/**
 * Makes `dir` if it is missing, then refuses it unless this user owns it and
 * nobody else can enter it. Throws with the reason, so a daemon never listens
 * somewhere another user prepared.
 */
export function prepareSocketDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(dir)
  const uid = process.getuid?.()
  if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) {
    throw new Error('the socket directory is not a directory this user owns')
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error('the socket directory must be owner-only (0700)')
  }
}

/**
 * Clears a socket file a previous daemon left behind, and refuses when a
 * daemon is still answering on it — the startup lock should make that
 * impossible, so it is said rather than overwritten.
 */
export async function clearStaleSocket(path: string): Promise<void> {
  const answering = await new Promise<boolean>((resolveProbe) => {
    const probe = connect(path)
    probe.once('connect', () => {
      probe.destroy()
      resolveProbe(true)
    })
    probe.once('error', () => resolveProbe(false))
  })
  if (answering) throw new Error('another daemon is already listening on this socket')
  rmSync(path, { force: true })
}

/**
 * Serves `fetch` on the socket at `path` — the same app the loopback port
 * serves, so its auth applies unchanged. Closing the server unlinks the file;
 * one a killed daemon left behind is `clearStaleSocket`'s.
 */
export async function listenOnSocket(
  fetch: (request: Request) => Response | Promise<Response>,
  path: string,
): Promise<{ path: string; close: () => Promise<void> }> {
  prepareSocketDirectory(dirname(path))
  await clearStaleSocket(path)
  const server = createAdaptorServer({ fetch })
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(path, () => resolveListen())
  })
  chmodSync(path, 0o600)
  return {
    path,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose())
        ;(server as { closeAllConnections?: () => void }).closeAllConnections?.()
      }),
  }
}
