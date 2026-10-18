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
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, rmSync, type Stats } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createAdaptorServer } from '@hono/node-server'
import { errnoCode, isErrnoCode, isMissingFileError } from '../shared/errno.js'

interface SocketPathContext {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly platform: NodeJS.Platform
  readonly uid: number
  readonly tmp?: string
}

function defaultContext(): SocketPathContext {
  return { env: process.env, platform: process.platform, uid: process.getuid?.() ?? -1 }
}

const PIPE_PREFIX = '\\\\.\\pipe\\'

/** Whether `path` names a Windows named pipe rather than a socket file. */
export function isNamedPipe(path: string): boolean {
  return path.startsWith(PIPE_PREFIX)
}

/**
 * The socket for the daemon keeping `dataDir`.
 *
 * Windows takes a named pipe (ADR-0050 decision 9). A pipe has no directory
 * to close, so its name is random rather than derived: another user who could
 * predict it could create the pipe first and receive the token the host
 * sends. Only the owner's daemon record says it, which is where every client
 * reads it from.
 */
export function daemonSocketPath(
  dataDir: string,
  context: SocketPathContext = defaultContext(),
): string {
  if (context.platform === 'win32')
    return `${PIPE_PREFIX}whiteboard-${randomBytes(16).toString('hex')}`
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
  const refusal = socketDirectoryRefusal(lstatSync(dir), process.getuid?.())
  if (refusal !== undefined) throw new Error(refusal)
}

/** The one rule a socket's directory is held to, by the daemon and its clients alike. */
function socketDirectoryRefusal(stat: Stats, uid: number | undefined): string | undefined {
  if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) {
    return (
      'the socket directory is not a directory this user owns. ' +
      'Set XDG_RUNTIME_DIR to a directory of your own (the socket lives in its whiteboard/ subdirectory), ' +
      'or TMPDIR when XDG_RUNTIME_DIR is unset.'
    )
  }
  if ((stat.mode & 0o077) !== 0) return 'the socket directory must be owner-only (0700)'
  return undefined
}

interface SocketTrustSeams {
  /** Whose socket it has to be; absent where the platform has no uids. */
  readonly uid?: number
  readonly lstat?: (path: string) => Stats
}

/**
 * - `trusted`: nothing says the socket may be someone else's.
 * - `absent`: its directory does not exist, so no daemon can be listening
 *   there — and nothing is to be sent, since whoever makes the directory
 *   before the connect decides who answers it.
 * - `refused`: the socket, or its directory, may be another user's.
 */
export type SocketTrust =
  | { readonly kind: 'trusted' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'refused'; readonly reason: string }

const TRUSTED: SocketTrust = { kind: 'trusted' }

function refused(reason: string): SocketTrust {
  return { kind: 'refused', reason }
}

/** `path`'s lstat, or undefined when nothing is there or a parent is no directory. */
function statUnlessMissing(lstat: (path: string) => Stats, path: string): Stats | undefined {
  try {
    return lstat(path)
  } catch (err) {
    if (isMissingFileError(err) || isErrnoCode(err, 'ENOTDIR')) return undefined
    throw err
  }
}

/**
 * Whether the socket at `path` may be sent the record's token — asked by every
 * client before it sends it there.
 *
 * A record outlives a daemon that did not stop cleanly, and the temp-dir
 * fallback's directory is a predictable name: once a reboot empties the temp
 * dir, another user can create it and listen at the recorded path. The
 * directory being this user's and closed is what makes the socket inside it
 * this user's, so it is checked here as `prepareSocketDirectory` checks it —
 * even when the socket itself is missing, since a directory another user owns
 * can be swapped for one holding their socket between this check and the
 * connect. A directory this user owns, in a sticky temp dir, nobody else can
 * swap.
 *
 * A file that is no socket in a directory this user holds alone is only
 * something nothing listens through. A named pipe has no directory, and is
 * held to its endpoint proof instead.
 */
export function socketTrust(
  path: string,
  { uid = process.getuid?.(), lstat = lstatSync }: SocketTrustSeams = {},
): SocketTrust {
  if (isNamedPipe(path)) return TRUSTED
  let socket: Stats | undefined
  try {
    socket = statUnlessMissing(lstat, path)
  } catch (err) {
    return refused(`the socket could not be inspected (${errnoCode(err) ?? 'unknown error'})`)
  }
  if (socket?.isSymbolicLink()) return refused('the socket path is a symbolic link')
  let directory: Stats | undefined
  try {
    directory = statUnlessMissing(lstat, dirname(path))
  } catch (err) {
    return refused(
      `the socket directory could not be inspected (${errnoCode(err) ?? 'unknown error'})`,
    )
  }
  if (directory === undefined) {
    return socket === undefined
      ? { kind: 'absent' }
      : refused('the socket directory could not be inspected (ENOENT)')
  }
  const refusal = socketDirectoryRefusal(directory, uid)
  if (refusal !== undefined) return refused(refusal)
  if (socket?.isSocket() && uid !== undefined && socket.uid !== uid) {
    return refused('the socket is not owned by this user')
  }
  return TRUSTED
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

// What a `sun_path` holds, less the NUL a C reader expects after the name:
// macOS 104, Linux 108. Linux binds one byte more; a name that fills the
// field leaves nothing for a reader that stops at the terminator.
const SOCKET_PATH_MAX_BYTES = process.platform === 'darwin' ? 103 : 107

/**
 * The kernel truncates a longer name at bind instead of refusing it, so the
 * daemon would listen on a path nobody asked for and then fail on the first
 * thing that uses the real one (the chmod, a client's connect), naming
 * neither the cause nor the limit.
 */
function assertSocketPathFits(path: string): void {
  const bytes = Buffer.byteLength(path)
  if (bytes <= SOCKET_PATH_MAX_BYTES) return
  throw new Error(
    `the daemon socket path is ${bytes} bytes, over the ${SOCKET_PATH_MAX_BYTES}-byte limit for a unix socket: ${path}. ` +
      'Set XDG_RUNTIME_DIR to a shorter directory (the socket lives in its whiteboard/ subdirectory), ' +
      'or TMPDIR when XDG_RUNTIME_DIR is unset.',
  )
}

/**
 * Serves `fetch` on the socket at `path` — the daemon's only listener, so its
 * auth is the app's own. Closing the server unlinks the file; one a killed
 * daemon left behind is `clearStaleSocket`'s.
 */
export async function listenOnSocket(
  fetch: (request: Request) => Response | Promise<Response>,
  path: string,
): Promise<{ path: string; close: () => Promise<void> }> {
  // A pipe is not a file: there is no directory to close and nothing left
  // behind to clear, and its name is already one nobody else can know.
  const pipe = isNamedPipe(path)
  if (!pipe) {
    assertSocketPathFits(path)
    prepareSocketDirectory(dirname(path))
    await clearStaleSocket(path)
  }
  const server = createAdaptorServer({ fetch })
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(path, () => resolveListen())
  })
  if (!pipe) chmodSync(path, 0o600)
  return {
    path,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose())
        ;(server as { closeAllConnections?: () => void }).closeAllConnections?.()
      }),
  }
}
