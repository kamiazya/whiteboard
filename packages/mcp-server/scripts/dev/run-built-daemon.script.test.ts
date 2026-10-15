// `pnpm mcp:http` runs the BUILT daemon on the checkout's `.dev-data`, which the
// source dev daemon migrates forward on every start. A `dist` built before the
// newest migration landed then refuses that store with an "upgrade to the
// latest release" error a checkout cannot act on — the release may not ship
// that migration either. So the launcher compares the build with the source
// before spawning, and names the command that fixes it.
//
// The script resolves `dist/` and `src/` from its own location, so this runs a
// copy of it inside a throwaway package whose build and source are fixtures.
import { execFileSync, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { devSpawnLockPath } from './with-dev-data-dir-lib.mjs'

const HERE = import.meta.dirname

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function write(path: string, content: string) {
  mkdirSync(resolve(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

/**
 * A package whose source registers `sourceMigrations` and whose build ships
 * `builtMigrations`. Its daemon entry records that it was started and exits.
 */
function fakePackage(sourceMigrations: string[], builtMigrations: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'wb-run-built-daemon-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', root])
  for (const script of [
    'run-built-daemon.mjs',
    'with-dev-data-dir-lib.mjs',
    'dev-daemon-socket-lib.mjs',
    'dev-spawn-lock-lib.mjs',
    'ensure-http-dev-daemon-lib.mjs',
  ]) {
    mkdirSync(join(root, 'scripts/dev'), { recursive: true })
    copyFileSync(join(HERE, script), join(root, 'scripts/dev', script))
  }
  write(
    join(root, 'src/server/store/db/migrations/index.ts'),
    `export const migrations = {\n${sourceMigrations.map((name) => `  '${name}': m,`).join('\n')}\n}\n`,
  )
  const started = join(root, 'daemon-started')
  write(
    join(root, 'dist/server/daemon-entry.js'),
    `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(started)}, 'yes')\n`,
  )
  // A bundler puts the registry in whichever chunk it likes.
  write(
    join(root, 'dist/prepare-AbC123.js'),
    `const migrations = { ${builtMigrations.map((name) => `"${name}": m`).join(', ')} };\n`,
  )
  return { root, started }
}

function runLauncher(root: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [join(root, 'scripts/dev/run-built-daemon.mjs')], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, WHITEBOARD_DATA_DIR: join(root, 'data'), ...extraEnv },
    timeout: 30_000,
  })
}

describe('run-built-daemon', () => {
  it('refuses a build that lacks the newest source migration, naming pnpm build', () => {
    const { root, started } = fakePackage(
      ['0001-init', '0002-later', '0003-newest'],
      ['0001-init', '0002-later'],
    )
    const result = runLauncher(root)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('0003-newest')
    expect(result.stderr).toContain('pnpm build')
    expect(existsSync(started)).toBe(false)
  })

  // The SessionStart hook keeps a source dev daemon on the same `.dev-data`.
  // The built one cannot take its socket, and handing over to it would test
  // watch-mode source instead of the artifact asked for — so it refuses, by name.
  it('refuses while a dev daemon is running, naming pnpm mcp:http:stop', () => {
    const { root, started } = fakePackage(['0001-init'], ['0001-init'])
    write(
      join(root, 'data', 'daemon.json'),
      JSON.stringify({
        pid: process.pid,
        socketPath: join(root, 'data', 'absent.sock'),
        token: 't',
        startedAt: new Date().toISOString(),
      }),
    )
    const result = runLauncher(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`pid ${process.pid}`)
    expect(result.stderr).toContain(join(root, 'data'))
    expect(result.stderr).toContain('pnpm mcp:http:stop')
    expect(existsSync(started)).toBe(false)
    // Left behind, the lock would name a pid an unrelated process can reuse,
    // and the next start would be refused for the whole staleness window.
    expect(existsSync(devSpawnLockPath(join(root, 'data')))).toBe(false)
  })

  // A daemon that crashed leaves its record behind. Refusing on the file alone
  // would stop `pnpm mcp:http` until someone deleted it by hand.
  it('starts beside a daemon.json left by a daemon whose pid is dead', () => {
    const { root, started } = fakePackage(['0001-init'], ['0001-init'])
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid
    write(
      join(root, 'data', 'daemon.json'),
      JSON.stringify({
        pid: deadPid,
        socketPath: join(root, 'data', 'absent.sock'),
        token: 't',
        startedAt: new Date().toISOString(),
      }),
    )
    const result = runLauncher(root)
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(existsSync(started)).toBe(true)
  })

  // The lock exists for the boot window: a second daemon starting before the
  // first has written its record fails its migrations instead of being told
  // one is already starting. So the launcher holds it from before the spawn
  // until the record names its child — and no longer, or the next start
  // would wait out a daemon that is already up.
  it('holds the spawn lock until the daemon record names the child, then lets go', () => {
    const { root } = fakePackage(['0001-init'], ['0001-init'])
    const dataDir = join(root, 'data')
    const observed = join(root, 'boot-observed.json')
    write(
      join(root, 'dist/server/daemon-entry.js'),
      [
        "import { existsSync, writeFileSync } from 'node:fs'",
        `const lock = ${JSON.stringify(devSpawnLockPath(dataDir))}`,
        'const lockHeldAtBoot = existsSync(lock)',
        `writeFileSync(${JSON.stringify(join(dataDir, 'daemon.json'))}, JSON.stringify({ pid: process.pid, socketPath: ${JSON.stringify(join(dataDir, 'absent.sock'))}, token: 't', startedAt: new Date().toISOString() }))`,
        'const giveUpAt = Date.now() + 10_000',
        'const poll = setInterval(() => {',
        '  const released = !existsSync(lock)',
        '  if (!released && Date.now() < giveUpAt) return',
        '  clearInterval(poll)',
        `  writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ lockHeldAtBoot, releasedWhileRunning: released }))`,
        '}, 20)',
      ].join('\n'),
    )
    // A boot budget far past the fake daemon's own deadline, so a launcher
    // that waits out the budget instead of the record is told apart.
    const result = runLauncher(root, { WHITEBOARD_DEV_READY_TIMEOUT_MS: '60000' })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(JSON.parse(readFileSync(observed, 'utf8'))).toEqual({
      lockHeldAtBoot: true,
      releasedWhileRunning: true,
    })
  }, 30_000)

  it('refuses while another dev daemon is starting under the spawn lock', () => {
    const { root, started } = fakePackage(['0001-init'], ['0001-init'])
    write(
      devSpawnLockPath(join(root, 'data')),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    )
    const result = runLauncher(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`pid ${process.pid}`)
    expect(result.stderr).toContain('pnpm mcp:http:stop')
    expect(existsSync(started)).toBe(false)
  })

  it('starts a build that ships every source migration', () => {
    const { root, started } = fakePackage(['0001-init', '0002-later'], ['0001-init', '0002-later'])
    const result = runLauncher(root)
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(existsSync(started)).toBe(true)
    expect(existsSync(devSpawnLockPath(join(root, 'data')))).toBe(false)
  })
})
