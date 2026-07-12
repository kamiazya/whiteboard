import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { captureLogsForTests, getLogLevel, isLogLevelEnabled, setLogLevel } from './log.js'
import {
  applyConfigFileToEnv,
  applyConfigFileToEnvAndLogLevel,
  loadConfigFile,
} from './config-file.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'whiteboard-config-file-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
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
      JSON.stringify({ allowedWebOrigins: ['https://a.example'], port: 4000 }),
    )
    const loaded = loadConfigFile(dir)
    expect(loaded?.config).toEqual({ allowedWebOrigins: ['https://a.example'], port: 4000 })
    expect(loaded?.filepath).toBe(join(dir, '.whiteboardrc.json'))
  })

  it('parses YAML from .whiteboard/config.yaml', () => {
    mkdirSync(join(dir, '.whiteboard'))
    writeFileSync(
      join(dir, '.whiteboard', 'config.yaml'),
      'allowedWebOrigins:\n  - https://a.example\nport: 4001\n',
    )
    const loaded = loadConfigFile(dir)
    expect(loaded?.config).toEqual({ allowedWebOrigins: ['https://a.example'], port: 4001 })
  })

  it('parses an extensionless .whiteboardrc (JSON body)', () => {
    writeFileSync(join(dir, '.whiteboardrc'), JSON.stringify({ port: 4002 }))
    const loaded = loadConfigFile(dir)
    expect(loaded?.config).toEqual({ port: 4002 })
  })

  it('reads package.json#whiteboard when nothing else matches', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'x', whiteboard: { port: 4003 } }),
    )
    const loaded = loadConfigFile(dir)
    expect(loaded?.config).toEqual({ port: 4003 })
  })

  it('prefers .whiteboardrc over .whiteboardrc.yaml and package.json in the same directory', () => {
    writeFileSync(join(dir, '.whiteboardrc'), JSON.stringify({ port: 1 }))
    writeFileSync(join(dir, '.whiteboardrc.yaml'), 'port: 2\n')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', whiteboard: { port: 3 } }))
    const loaded = loadConfigFile(dir)
    expect(loaded?.config.port).toBe(1)
  })

  it('does NOT walk up to a parent directory: a config file above cwd is ignored', () => {
    // An ancestor directory (e.g. the root of an untrusted cloned repo) must
    // not be able to plant a config that a nested cwd picks up implicitly.
    writeFileSync(join(dir, '.whiteboardrc.json'), JSON.stringify({ port: 4004 }))
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
      writeFileSync(join(homeDir, '.whiteboard', 'config.yaml'), 'port: 4005\n')
      const loaded = loadConfigFile(dir, { homeDir })
      expect(loaded?.config).toEqual({ port: 4005 })
    } finally {
      rmSync(homeDir, { recursive: true, force: true })
    }
  })

  it('warns and drops unknown keys but still loads known ones', () => {
    writeFileSync(join(dir, '.whiteboardrc.json'), JSON.stringify({ port: 4006, extraKey: 'nope' }))
    const capture = captureLogsForTests()
    try {
      const loaded = loadConfigFile(dir)
      expect(loaded?.config).toEqual({ port: 4006 })
      const warning = capture.records.find((r) => r.msg.includes('unknown whiteboard config'))
      expect(warning).toBeDefined()
      expect(warning?.data?.filepath).toBe(join(dir, '.whiteboardrc.json'))
      expect(warning?.data?.unknownKeys).toEqual(['extraKey'])
    } finally {
      capture.restore()
    }
  })

  it('fails fast with the file path and key on an invalid value', () => {
    writeFileSync(join(dir, '.whiteboardrc.json'), JSON.stringify({ port: 'not-a-number' }))
    expect(() => loadConfigFile(dir)).toThrow(/\.whiteboardrc\.json/)
    expect(() => loadConfigFile(dir)).toThrow(/port/)
  })

  it('parses the openBrowser key', () => {
    writeFileSync(join(dir, '.whiteboardrc.json'), JSON.stringify({ openBrowser: false }))
    const loaded = loadConfigFile(dir)
    expect(loaded?.config).toEqual({ openBrowser: false })
  })

  it('fails fast when openBrowser is not a boolean', () => {
    writeFileSync(join(dir, '.whiteboardrc.json'), JSON.stringify({ openBrowser: 'nope' }))
    expect(() => loadConfigFile(dir)).toThrow(/openBrowser/)
  })

  it('never includes the token value in a thrown validation message for another key', () => {
    writeFileSync(
      join(dir, '.whiteboardrc.json'),
      JSON.stringify({ token: 'super-secret-token', port: 'bad' }),
    )
    try {
      loadConfigFile(dir)
      throw new Error('expected loadConfigFile to throw')
    } catch (err) {
      expect(String(err)).not.toContain('super-secret-token')
    }
  })

  it('never executes JS reached via a config $import, even though $import can point anywhere', () => {
    const sentinel = join(dir, 'sentinel.txt')
    writeFileSync(
      join(dir, 'evil.js'),
      `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed'); module.exports = { token: 'pwned' }`,
    )
    writeFileSync(join(dir, '.whiteboardrc.json'), JSON.stringify({ $import: './evil.js' }))
    expect(() => loadConfigFile(dir)).toThrow()
    expect(existsSync(sentinel)).toBe(false)
  })

  it('propagates a parse error from the home fallback config instead of silently returning null', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'whiteboard-config-home-'))
    try {
      mkdirSync(join(homeDir, '.whiteboard'), { recursive: true })
      writeFileSync(join(homeDir, '.whiteboard', 'config.yaml'), 'port: [1, 2\n')
      expect(() => loadConfigFile(dir, { homeDir })).toThrow()
    } finally {
      rmSync(homeDir, { recursive: true, force: true })
    }
  })
})

describe('applyConfigFileToEnv', () => {
  it('sets unset WHITEBOARD_* keys from the file config', () => {
    const env: Record<string, string | undefined> = {}
    applyConfigFileToEnv(
      {
        allowedWebOrigins: ['https://a.example', 'https://b.example'],
        token: 'file-token',
        logLevel: 'debug',
        dataDir: '/tmp/whiteboard-data',
      },
      env,
    )
    expect(env.WHITEBOARD_ALLOWED_WEB_ORIGINS).toBe('https://a.example,https://b.example')
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
      WHITEBOARD_ALLOWED_WEB_ORIGINS: 'https://env.example',
      WHITEBOARD_TOKEN: 'env-token',
      WHITEBOARD_DAEMON_TOKEN: 'env-daemon-token',
      WHITEBOARD_LOG_LEVEL: 'error',
      WHITEBOARD_DATA_DIR: '/env/data',
    }
    applyConfigFileToEnv(
      {
        allowedWebOrigins: ['https://file.example'],
        token: 'file-token',
        logLevel: 'debug',
        dataDir: '/file/data',
      },
      env,
    )
    expect(env.WHITEBOARD_ALLOWED_WEB_ORIGINS).toBe('https://env.example')
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
      expect(isLogLevelEnabled('debug')).toBe(true)
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
