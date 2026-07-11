import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { captureLogsForTests } from './log.js'
import { applyConfigFileToEnv, loadConfigFile } from './config-file.js'

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

  it('walks up from a nested cwd to find a config in a parent directory', () => {
    writeFileSync(join(dir, '.whiteboardrc.json'), JSON.stringify({ port: 4004 }))
    const nested = join(dir, 'a', 'b', 'c')
    mkdirSync(nested, { recursive: true })
    const loaded = loadConfigFile(nested)
    expect(loaded?.config.port).toBe(4004)
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
