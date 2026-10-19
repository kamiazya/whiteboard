import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyConfigFileToEnv,
  applyConfigFileToEnvAndLogLevel,
  loadConfigFile,
  type WhiteboardConfigFile,
  whiteboardConfigFileSchema,
} from './config-file.js'
import { captureLogsForTests, getLogLevel, setLogLevel } from './log.js'

let dir: string
// The home config is always read, so a case about the cwd file alone points
// it at an empty directory rather than at whatever the machine running it has.
let emptyHome: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'whiteboard-config-file-'))
  emptyHome = mkdtempSync(join(tmpdir(), 'whiteboard-config-empty-home-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(emptyHome, { recursive: true, force: true })
})

describe('loadConfigFile', () => {
  it('returns null when no config file exists anywhere', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'whiteboard-config-home-'))
    try {
      expect(loadConfigFile(dir, { homeDir })).toBeNull()
    } finally {
      rmSync(homeDir, { recursive: true, force: true })
    }
  })

  it('parses a .whiteboardrc.json file', () => {
    writeFileSync(
      join(dir, '.whiteboardrc.json'),
      JSON.stringify({ logLevel: 'info', openBrowser: false }),
    )
    const loaded = loadConfigFile(dir, { homeDir: emptyHome })
    expect(loaded?.config).toEqual({ logLevel: 'info', openBrowser: false })
    expect(loaded?.filepaths).toEqual([join(dir, '.whiteboardrc.json')])
  })

  it('parses YAML from .whiteboard/config.yaml', () => {
    mkdirSync(join(dir, '.whiteboard'))
    writeFileSync(join(dir, '.whiteboard', 'config.yaml'), 'logLevel: debug\nopenBrowser: true\n')
    const loaded = loadConfigFile(dir, { homeDir: emptyHome })
    expect(loaded?.config).toEqual({ logLevel: 'debug', openBrowser: true })
  })

  it('parses an extensionless .whiteboardrc (JSON body)', () => {
    writeFileSync(join(dir, '.whiteboardrc'), JSON.stringify({ logLevel: 'notice' }))
    const loaded = loadConfigFile(dir, { homeDir: emptyHome })
    expect(loaded?.config).toEqual({ logLevel: 'notice' })
  })

  it('reads package.json#whiteboard when nothing else matches', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'x', whiteboard: { logLevel: 'error' } }),
    )
    const loaded = loadConfigFile(dir, { homeDir: emptyHome })
    expect(loaded?.config).toEqual({ logLevel: 'error' })
  })

  it('prefers .whiteboardrc over .whiteboardrc.yaml and package.json in the same directory', () => {
    writeFileSync(join(dir, '.whiteboardrc'), JSON.stringify({ logLevel: 'debug' }))
    writeFileSync(join(dir, '.whiteboardrc.yaml'), 'logLevel: info\n')
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'x', whiteboard: { logLevel: 'error' } }),
    )
    const loaded = loadConfigFile(dir, { homeDir: emptyHome })
    expect(loaded?.config.logLevel).toBe('debug')
  })

  it('does NOT walk up to a parent directory: a config file above cwd is ignored', () => {
    // An ancestor directory (e.g. the root of an untrusted cloned repo) must
    // not be able to plant a config that a nested cwd picks up implicitly.
    writeFileSync(join(dir, '.whiteboardrc.json'), JSON.stringify({ logLevel: 'debug' }))
    const nested = join(dir, 'a', 'b', 'c')
    mkdirSync(nested, { recursive: true })
    const homeDir = mkdtempSync(join(tmpdir(), 'whiteboard-config-home-'))
    try {
      expect(loadConfigFile(nested, { homeDir })).toBeNull()
    } finally {
      rmSync(homeDir, { recursive: true, force: true })
    }
  })

  it('falls back to ~/.whiteboard/config.yaml when nothing is found from cwd', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'whiteboard-config-home-'))
    try {
      mkdirSync(join(homeDir, '.whiteboard'), { recursive: true })
      writeFileSync(join(homeDir, '.whiteboard', 'config.yaml'), 'logLevel: debug\n')
      const loaded = loadConfigFile(dir, { homeDir })
      expect(loaded?.config).toEqual({ logLevel: 'debug' })
    } finally {
      rmSync(homeDir, { recursive: true, force: true })
    }
  })

  it('warns and drops unknown keys but still loads known ones', () => {
    writeFileSync(
      join(dir, '.whiteboardrc.json'),
      JSON.stringify({ logLevel: 'debug', extraKey: 'nope' }),
    )
    const capture = captureLogsForTests()
    try {
      const loaded = loadConfigFile(dir, { homeDir: emptyHome })
      expect(loaded?.config).toEqual({ logLevel: 'debug' })
      const warning = capture.records.find((r) => r.msg.includes('unknown whiteboard config'))
      expect(warning).toBeDefined()
      expect(warning?.data?.filepath).toBe(join(dir, '.whiteboardrc.json'))
      expect(warning?.data?.unknownKeys).toEqual(['extraKey'])
    } finally {
      capture.restore()
    }
  })

  // Unknown keys are dropped before the strict schema runs, so a key the
  // schema declares but the filter does not know would be warned about and
  // silently ignored, never reaching validation. Every declared key must
  // survive a load.
  it('keeps every key the schema declares, and reports none of them as unknown', () => {
    const samples: Required<WhiteboardConfigFile> = {
      token: 'dev-token',
      logLevel: 'info',
      dataDir: '/tmp/wb',
      openBrowser: false,
    }
    const declared = Object.keys(whiteboardConfigFileSchema.shape)
    expect(declared.length).toBeGreaterThan(0)
    for (const key of declared) {
      expect(samples, `add a sample value for the new config key "${key}"`).toHaveProperty(key)
    }
    // The home config, since a working-directory one may not set every key.
    const homeDir = mkdtempSync(join(tmpdir(), 'whiteboard-config-home-'))
    mkdirSync(join(homeDir, '.whiteboard'))
    writeFileSync(join(homeDir, '.whiteboard', 'config.yaml'), JSON.stringify(samples))
    const capture = captureLogsForTests()
    try {
      expect(loadConfigFile(dir, { homeDir })?.config).toEqual(samples)
      expect(capture.records.filter((r) => r.msg.includes('unknown whiteboard config'))).toEqual([])
    } finally {
      capture.restore()
      rmSync(homeDir, { recursive: true, force: true })
    }
  })

  it('fails fast with the file path and key on an invalid value', () => {
    writeFileSync(join(dir, '.whiteboardrc.json'), JSON.stringify({ logLevel: 'not-a-level' }))
    expect(() => loadConfigFile(dir, { homeDir: emptyHome })).toThrow(/\.whiteboardrc\.json/)
    expect(() => loadConfigFile(dir, { homeDir: emptyHome })).toThrow(/logLevel/)
  })

  it('parses the openBrowser key', () => {
    writeFileSync(join(dir, '.whiteboardrc.json'), JSON.stringify({ openBrowser: false }))
    const loaded = loadConfigFile(dir, { homeDir: emptyHome })
    expect(loaded?.config).toEqual({ openBrowser: false })
  })

  it('fails fast when openBrowser is not a boolean', () => {
    writeFileSync(join(dir, '.whiteboardrc.json'), JSON.stringify({ openBrowser: 'nope' }))
    expect(() => loadConfigFile(dir, { homeDir: emptyHome })).toThrow(/openBrowser/)
  })

  it('never includes the token value in a thrown validation message for another key', () => {
    writeFileSync(
      join(dir, '.whiteboardrc.json'),
      JSON.stringify({ token: 'super-secret-token', logLevel: 'bad' }),
    )
    try {
      loadConfigFile(dir, { homeDir: emptyHome })
      throw new Error('expected loadConfigFile to throw')
    } catch (err) {
      expect(String(err)).not.toContain('super-secret-token')
    }
  })

  // Every code-bearing extension must be refused by our loader — not by
  // whatever cosmiconfig's defaults happen to do with it. A working-directory
  // file cannot `$import` at all (below), so this is reached through the
  // home config, the one place `$import` is honoured.
  it.each([
    'js',
    'cjs',
    'mjs',
    'ts',
  ])('never executes .%s code reached via a config $import, even though $import can point anywhere', (ext) => {
    const sentinel = join(dir, 'sentinel.txt')
    const body =
      ext === 'mjs'
        ? `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'executed'); export default { token: 'pwned' }`
        : `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed'); module.exports = { token: 'pwned' }`
    writeFileSync(join(dir, `evil.${ext}`), body)
    mkdirSync(join(emptyHome, '.whiteboard'))
    writeFileSync(
      join(emptyHome, '.whiteboard', 'config.yaml'),
      JSON.stringify({ $import: join(dir, `evil.${ext}`) }),
    )
    expect(() => loadConfigFile(dir, { homeDir: emptyHome })).toThrow(/must never execute code/)
    expect(existsSync(sentinel)).toBe(false)
  })

  it('propagates a parse error from the home fallback config instead of silently returning null', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'whiteboard-config-home-'))
    try {
      mkdirSync(join(homeDir, '.whiteboard'), { recursive: true })
      writeFileSync(join(homeDir, '.whiteboard', 'config.yaml'), 'logLevel: [1, 2\n')
      expect(() => loadConfigFile(dir, { homeDir })).toThrow()
    } finally {
      rmSync(homeDir, { recursive: true, force: true })
    }
  })
})

// The working directory is wherever an MCP client started us, often a cloned
// repo nobody here vetted. A file there may tune how we run, but not WHERE our
// data lives or WHICH token guards the daemon: those two are honoured only from
// the home-directory config.
describe('loadConfigFile refuses dataDir and token from the working directory', () => {
  let homeDir: string
  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'whiteboard-config-home-'))
  })
  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true })
  })

  it.each([
    ['dataDir', { dataDir: './evil' }],
    ['token', { token: 'planted-token' }],
  ] as const)('refuses %s in a cwd .whiteboardrc, naming the file and the key', (key, body) => {
    writeFileSync(join(dir, '.whiteboardrc'), JSON.stringify({ logLevel: 'info', ...body }))
    let thrown: unknown
    try {
      loadConfigFile(dir, { homeDir })
    } catch (err) {
      thrown = err
    }
    expect(String(thrown)).toContain(join(dir, '.whiteboardrc'))
    expect(String(thrown)).toContain(`"${key}"`)
    expect(String(thrown)).not.toContain('planted-token')
  })

  it('refuses dataDir from package.json#whiteboard in cwd', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ whiteboard: { dataDir: '/x' } }))
    expect(() => loadConfigFile(dir, { homeDir })).toThrow(/"dataDir"/)
  })

  it('still honours logLevel and openBrowser from cwd', () => {
    writeFileSync(
      join(dir, '.whiteboardrc'),
      JSON.stringify({ logLevel: 'debug', openBrowser: false }),
    )
    expect(loadConfigFile(dir, { homeDir })?.config).toEqual({
      logLevel: 'debug',
      openBrowser: false,
    })
  })

  it('honours dataDir and token from the home-directory config', () => {
    mkdirSync(join(homeDir, '.whiteboard'))
    writeFileSync(join(homeDir, '.whiteboard', 'config.yaml'), 'dataDir: /data\ntoken: t\n')
    expect(loadConfigFile(dir, { homeDir })?.config).toEqual({ dataDir: '/data', token: 't' })
  })

  it('honours the home-directory config when cwd is the home directory itself', () => {
    mkdirSync(join(homeDir, '.whiteboard'))
    writeFileSync(join(homeDir, '.whiteboard', 'config.yaml'), 'dataDir: /data\n')
    expect(loadConfigFile(homeDir, { homeDir })?.config).toEqual({ dataDir: '/data' })
    expect(loadConfigFile(homeDir, { homeDir })?.filepaths).toEqual([
      join(homeDir, '.whiteboard', 'config.yaml'),
    ])
  })
})

// `$import` makes cosmiconfig read and parse any path the file names, before
// any key of ours is checked. From the working directory that is a repo's
// author choosing which of the user's files the daemon opens — and a parse
// error quotes what it read. Refused there, like dataDir and token, before the
// target is read; still honoured from the home config, which is the user's own.
describe('loadConfigFile refuses $import from the working directory', () => {
  let homeDir: string
  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'whiteboard-config-home-'))
  })
  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true })
  })

  // A target whose parse would fail: if it were read, the error would be
  // the parser's, not the refusal.
  function unparseableTarget(): string {
    const target = join(homeDir, 'private.yaml')
    writeFileSync(target, 'secret: [unterminated\n')
    return target
  }

  it.each([
    ['.whiteboardrc', (target: string) => JSON.stringify({ $import: target })],
    ['.whiteboardrc.json', (target: string) => JSON.stringify({ $import: [target] })],
    ['.whiteboardrc.yaml', (target: string) => `$import: ${JSON.stringify(target)}\n`],
  ] as const)('refuses $import in a cwd %s before reading what it names', (name, body) => {
    writeFileSync(join(dir, name), body(unparseableTarget()))
    let thrown: unknown
    try {
      loadConfigFile(dir, { homeDir })
    } catch (err) {
      thrown = err
    }
    expect(String(thrown)).toContain(join(dir, name))
    expect(String(thrown)).toContain('"$import"')
  })

  it('refuses $import from package.json#whiteboard in cwd', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'x', whiteboard: { $import: unparseableTarget() } }),
    )
    expect(() => loadConfigFile(dir, { homeDir })).toThrow(/"\$import"/)
  })

  it('honours $import from the home-directory config', () => {
    writeFileSync(join(homeDir, 'shared.yaml'), 'logLevel: debug\n')
    mkdirSync(join(homeDir, '.whiteboard'))
    writeFileSync(join(homeDir, '.whiteboard', 'config.yaml'), '$import: ../shared.yaml\n')
    expect(loadConfigFile(dir, { homeDir })?.config).toEqual({ logLevel: 'debug' })
  })

  it('honours $import from the home config when cwd is the home directory itself', () => {
    writeFileSync(join(homeDir, 'shared.yaml'), 'dataDir: /data\n')
    mkdirSync(join(homeDir, '.whiteboard'))
    writeFileSync(join(homeDir, '.whiteboard', 'config.yaml'), '$import: ../shared.yaml\n')
    expect(loadConfigFile(homeDir, { homeDir })?.config).toEqual({ dataDir: '/data' })
  })
})

describe('loadConfigFile layers a working-directory config over the home one', () => {
  let homeDir: string
  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'whiteboard-config-home-'))
    mkdirSync(join(homeDir, '.whiteboard'))
    writeFileSync(
      join(homeDir, '.whiteboard', 'config.yaml'),
      'dataDir: /data\ntoken: t\nlogLevel: warning\nopenBrowser: true\n',
    )
  })
  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('keeps the home dataDir and token when a cwd file sets only logLevel', () => {
    writeFileSync(join(dir, '.whiteboardrc'), JSON.stringify({ logLevel: 'debug' }))
    const loaded = loadConfigFile(dir, { homeDir })
    expect(loaded?.config).toEqual({
      dataDir: '/data',
      token: 't',
      logLevel: 'debug',
      openBrowser: true,
    })
    expect(loaded?.filepaths).toEqual([
      join(homeDir, '.whiteboard', 'config.yaml'),
      join(dir, '.whiteboardrc'),
    ])
  })

  it('lets each key the cwd file sets win over the home value', () => {
    writeFileSync(join(dir, '.whiteboardrc'), JSON.stringify({ openBrowser: false }))
    expect(loadConfigFile(dir, { homeDir })?.config).toMatchObject({
      logLevel: 'warning',
      openBrowser: false,
    })
  })

  it('still refuses a cwd file that sets token, whatever the home file holds', () => {
    writeFileSync(join(dir, '.whiteboardrc'), JSON.stringify({ token: 'planted-token' }))
    expect(() => loadConfigFile(dir, { homeDir })).toThrow(/"token"/)
  })
})

describe('applyConfigFileToEnv', () => {
  it('sets unset WHITEBOARD_* keys from the file config', () => {
    const env: Record<string, string | undefined> = {}
    applyConfigFileToEnv(
      {
        token: 'file-token',
        logLevel: 'debug',
        dataDir: '/tmp/whiteboard-data',
      },
      env,
    )
    expect(env.WHITEBOARD_TOKEN).toBe('file-token')
    expect(env.WHITEBOARD_DAEMON_TOKEN).toBe('file-token')
    expect(env.WHITEBOARD_LOG_LEVEL).toBe('debug')
    expect(env.WHITEBOARD_DATA_DIR).toBe('/tmp/whiteboard-data')
  })

  it('leaves BOTH token seams alone when either one is already set in the env', () => {
    // Filling only the unset seam would give the daemon and the server
    // entrypoint two different tokens (env value on one side, file value on
    // the other) — a mismatch worse than not applying the file token at all.
    const tokenOnly: Record<string, string | undefined> = { WHITEBOARD_TOKEN: 'env-token' }
    applyConfigFileToEnv({ token: 'file-token' }, tokenOnly)
    expect(tokenOnly.WHITEBOARD_TOKEN).toBe('env-token')
    expect(tokenOnly.WHITEBOARD_DAEMON_TOKEN).toBeUndefined()

    const daemonOnly: Record<string, string | undefined> = {
      WHITEBOARD_DAEMON_TOKEN: 'env-daemon-token',
    }
    applyConfigFileToEnv({ token: 'file-token' }, daemonOnly)
    expect(daemonOnly.WHITEBOARD_DAEMON_TOKEN).toBe('env-daemon-token')
    expect(daemonOnly.WHITEBOARD_TOKEN).toBeUndefined()
  })

  it('never overwrites an already-set env key (env wins over file)', () => {
    const env: Record<string, string | undefined> = {
      WHITEBOARD_TOKEN: 'env-token',
      WHITEBOARD_DAEMON_TOKEN: 'env-daemon-token',
      WHITEBOARD_LOG_LEVEL: 'error',
      WHITEBOARD_DATA_DIR: '/env/data',
    }
    applyConfigFileToEnv(
      {
        token: 'file-token',
        logLevel: 'debug',
        dataDir: '/file/data',
      },
      env,
    )
    expect(env.WHITEBOARD_TOKEN).toBe('env-token')
    expect(env.WHITEBOARD_DAEMON_TOKEN).toBe('env-daemon-token')
    expect(env.WHITEBOARD_LOG_LEVEL).toBe('error')
    expect(env.WHITEBOARD_DATA_DIR).toBe('/env/data')
  })

  it('does not touch process.env when the config has no relevant keys', () => {
    const env: Record<string, string | undefined> = {}
    applyConfigFileToEnv({}, env)
    expect(env).toEqual({})
  })
})

describe('applyConfigFileToEnvAndLogLevel', () => {
  it('applies a file logLevel to the running logger when WHITEBOARD_LOG_LEVEL is unset', () => {
    const env: Record<string, string | undefined> = {}
    const previousLevel = getLogLevel()
    try {
      applyConfigFileToEnvAndLogLevel({ logLevel: 'debug' }, env)
      expect(getLogLevel()).toBe('debug')
    } finally {
      setLogLevel(previousLevel)
    }
  })

  it('leaves the running logger level untouched when WHITEBOARD_LOG_LEVEL is already set (env wins)', () => {
    const env: Record<string, string | undefined> = { WHITEBOARD_LOG_LEVEL: 'error' }
    const previousLevel = getLogLevel()
    setLogLevel('warning')
    try {
      applyConfigFileToEnvAndLogLevel({ logLevel: 'debug' }, env)
      expect(getLogLevel()).toBe('warning')
      expect(env.WHITEBOARD_LOG_LEVEL).toBe('error')
    } finally {
      setLogLevel(previousLevel)
    }
  })
})

describe('loadConfigFile refuses a file whose root is not an object', () => {
  it.each([
    ['a list', '["logLevel", "debug"]'],
    ['a string', '"logLevel: debug"'],
    ['a number', '42'],
  ])('%s', (_name, body) => {
    writeFileSync(join(dir, '.whiteboardrc.json'), body)
    expect(() => loadConfigFile(dir, { homeDir: emptyHome })).toThrow(
      /expected an object at the root/,
    )
  })
})

// A file in the working directory is read and parsed before any key of ours
// is looked at, and a parse error quotes what it read. A link there lets a
// repo's author choose which of the user's files is opened; a FIFO or a
// device would block the synchronous read and hang startup. The home config,
// the user's own, keeps following links.
describe('loadConfigFile refuses a working-directory config that is not a regular file', () => {
  const SENTINEL = 'sentinel-private-content-7f3a'

  function privateTarget(): string {
    const target = join(emptyHome, 'private.txt')
    writeFileSync(target, `{ "${SENTINEL}": [unterminated`)
    return target
  }

  function thrownBy(fn: () => unknown): string {
    try {
      fn()
    } catch (err) {
      return String(err)
    }
    return '(nothing thrown)'
  }

  it.each([
    '.whiteboardrc',
    '.whiteboardrc.json',
    '.whiteboardrc.yaml',
    'whiteboard.config.json',
    'package.json',
  ])('refuses a symlinked %s without reading what it points at', (name) => {
    symlinkSync(privateTarget(), join(dir, name))
    const message = thrownBy(() => loadConfigFile(dir, { homeDir: emptyHome }))
    expect(message).not.toContain(SENTINEL)
    expect(message).toContain(join(dir, name))
    expect(message).toMatch(/not a regular file/)
    expect(message).toContain('honoured only in ~/.whiteboard/config.yaml')
  })

  it('refuses a symlinked .whiteboard directory', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'whiteboard-config-elsewhere-'))
    try {
      writeFileSync(join(elsewhere, 'config.yaml'), `${SENTINEL}: [unterminated\n`)
      symlinkSync(elsewhere, join(dir, '.whiteboard'))
      const message = thrownBy(() => loadConfigFile(dir, { homeDir: emptyHome }))
      expect(message).not.toContain(SENTINEL)
      expect(message).toContain(join(dir, '.whiteboard'))
      expect(message).toMatch(/not a directory/)
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('refuses a symlinked .whiteboard/config.yaml', () => {
    mkdirSync(join(dir, '.whiteboard'))
    symlinkSync(privateTarget(), join(dir, '.whiteboard', 'config.yaml'))
    const message = thrownBy(() => loadConfigFile(dir, { homeDir: emptyHome }))
    expect(message).not.toContain(SENTINEL)
    expect(message).toMatch(/not a regular file/)
  })

  it('refuses an oversize working-directory config without parsing it', () => {
    writeFileSync(
      join(dir, '.whiteboardrc.json'),
      `{ "${SENTINEL}": "${'x'.repeat(2 * 1024 * 1024)}" [`,
    )
    const message = thrownBy(() => loadConfigFile(dir, { homeDir: emptyHome }))
    expect(message).not.toContain(SENTINEL)
    expect(message).toMatch(/larger than/)
  })

  it('still follows a symlinked home config', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'whiteboard-config-dotfiles-'))
    try {
      writeFileSync(join(elsewhere, 'config.yaml'), 'dataDir: /data\n')
      symlinkSync(elsewhere, join(emptyHome, '.whiteboard'))
      expect(loadConfigFile(dir, { homeDir: emptyHome })?.config).toEqual({ dataDir: '/data' })
      expect(loadConfigFile(emptyHome, { homeDir: emptyHome })?.config).toEqual({
        dataDir: '/data',
      })
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })
})

/**
 * Whether this platform can make a FIFO. PROBED: a missing `mkfifo` binary or
 * a filesystem that refuses one is a premise the test cannot establish, which
 * is a skip, not a failure — and Windows has neither.
 */
function canMakeFifo(): boolean {
  if (process.platform === 'win32') return false
  const probeDir = mkdtempSync(join(tmpdir(), 'wb-fifo-probe-'))
  try {
    return spawnSync('mkfifo', [join(probeDir, 'p')]).status === 0
  } finally {
    rmSync(probeDir, { recursive: true, force: true })
  }
}
const CAN_MAKE_FIFO = canMakeFifo()
const MCP_SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// The read is synchronous, so a refusal that fails here would hang the worker
// rather than fail the test: it runs in a child with a deadline.
describe.skipIf(!CAN_MAKE_FIFO)('loadConfigFile and a FIFO in the working directory', () => {
  it('refuses a FIFO planted as .whiteboardrc.json instead of waiting on it', () => {
    expect(spawnSync('mkfifo', [join(dir, '.whiteboardrc.json')]).status).toBe(0)
    const module = pathToFileURL(join(MCP_SERVER_DIR, 'src/server/config-file.ts')).href
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx/esm',
        '--input-type=module',
        '--eval',
        `const { loadConfigFile } = await import(${JSON.stringify(module)})
try { loadConfigFile(${JSON.stringify(dir)}, { homeDir: ${JSON.stringify(emptyHome)} }); process.stdout.write('loaded') }
catch (err) { process.stdout.write(String(err)) }`,
      ],
      { cwd: MCP_SERVER_DIR, encoding: 'utf8', timeout: 20_000 },
    )
    expect(child.signal, 'the read blocked on the FIFO').toBeNull()
    expect(child.status, child.stderr).toBe(0)
    expect(child.stdout).toMatch(/not a regular file/)
  }, 30_000)
})
