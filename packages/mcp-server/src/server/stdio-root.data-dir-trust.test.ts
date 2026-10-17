/**
 * The stdio entry falls back to a directory under the temp dir when the home
 * directory cannot be written. Every local user shares that temp dir, so the
 * fallback has to be one this user alone owns and can enter, and a directory
 * someone else prepared there has to be refused rather than written into.
 */
import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { resolveDataDir } from '../shared/data-dir-secure.js'
import { CHMOD_IS_OBSERVABLE } from '../shared/test-utils/chmod-is-observable.js'
import { withTempDataDir } from './routes/_test-helpers.js'

const tmp = withTempDataDir('whiteboard-stdio-trust-')
const state = vi.hoisted(() => ({ dataDir: '' }))

vi.mock('./config.js', () => ({
  get DATA_DIR() {
    return state.dataDir
  },
  getDataDir: () => state.dataDir,
  get DIST_WEB_APP_DIR() {
    return join(state.dataDir, 'web-app')
  },
  WHITEBOARD_ROOT: '/tmp/whiteboard',
}))

const { bootStdioRoot } = await import('./stdio-root.js')

/** The directory the stdio entry resolves when the home dir is unwritable. */
function fallbackDataDir(): string {
  return resolveDataDir(
    {},
    {
      homeDir: join(tmp.dir, 'home'),
      tmpDir: join(tmp.dir, 'shared-tmp'),
      isWritableDir: () => false,
    },
  )
}

describe.skipIf(!CHMOD_IS_OBSERVABLE)('the stdio root on the temp-dir fallback', () => {
  it('names the fallback for this user rather than one every user shares', () => {
    const uid = process.getuid?.()
    const expected = uid === undefined ? '.whiteboard' : `.whiteboard-${uid}`
    expect(basename(fallbackDataDir())).toBe(expected)
  })

  it('creates the directory owner-only and the database unreadable by others', async () => {
    mkdirSync(join(tmp.dir, 'shared-tmp'), { recursive: true })
    state.dataDir = fallbackDataDir()

    await bootStdioRoot()

    expect(statSync(state.dataDir).mode & 0o777).toBe(0o700)
    const db = join(state.dataDir, 'whiteboard.db')
    expect(existsSync(db)).toBe(true)
    expect(statSync(db).mode & 0o077).toBe(0)
  })

  it('refuses a pre-created directory other users can write, and writes nothing into it', async () => {
    state.dataDir = fallbackDataDir()
    mkdirSync(state.dataDir, { recursive: true })
    chmodSync(state.dataDir, 0o777)
    expect(statSync(state.dataDir).mode & 0o777).toBe(0o777)

    await expect(bootStdioRoot()).rejects.toThrow(/writable by other users/)
    expect(existsSync(join(state.dataDir, 'whiteboard.db'))).toBe(false)
  })
})
