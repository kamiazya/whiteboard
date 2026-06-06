import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveDefaultDataDir } from './data-dir.js'

describe('resolveDefaultDataDir', () => {
  it('returns the env-override path when WHITEBOARD_DATA_DIR is set', () => {
    const result = resolveDefaultDataDir(
      { WHITEBOARD_DATA_DIR: '/custom/data' },
      { checkWritable: () => true, homeDir: '/home/user', tmpDir: '/tmp' },
    )
    expect(result).toBe('/custom/data')
  })

  it('returns ~/.whiteboard when home candidate is writable', () => {
    const result = resolveDefaultDataDir(
      {},
      { checkWritable: () => true, homeDir: '/home/user', tmpDir: '/tmp' },
    )
    expect(result).toBe('/home/user/.whiteboard')
  })

  it('falls back to tmp when home candidate is not writable (tmp fallback case)', () => {
    // status/stop/doctor must resolve the same dir as the server so they
    // can find the server record when the home dir is not writable.
    const result = resolveDefaultDataDir(
      {},
      { checkWritable: () => false, homeDir: '/home/user', tmpDir: '/tmp' },
    )
    expect(result).toBe('/tmp/.whiteboard')
  })

  it('resolves relative env-override to absolute path', () => {
    const result = resolveDefaultDataDir(
      { WHITEBOARD_DATA_DIR: 'relative/path' },
      { checkWritable: () => false, homeDir: '/home/user', tmpDir: '/tmp' },
    )
    expect(result).toMatch(/^\//)
  })

  it('normalises absolute env-override the same way resolveDataDir does (no redundant slashes or dot segments)', () => {
    // resolveDataDir always calls resolve(), so a path like /home/user//data
    // or /home/user/./data becomes /home/user/data. resolveDefaultDataDir must
    // agree so contract tests that compare the two resolvers stay consistent.
    const result = resolveDefaultDataDir(
      { WHITEBOARD_DATA_DIR: '/home/user//data' },
      { checkWritable: () => true, homeDir: '/home/user', tmpDir: '/tmp' },
    )
    expect(result).toBe('/home/user/data')
  })

  it('normalises absolute env-override with dot segments', () => {
    const result = resolveDefaultDataDir(
      { WHITEBOARD_DATA_DIR: '/home/user/./data' },
      { checkWritable: () => true, homeDir: '/home/user', tmpDir: '/tmp' },
    )
    expect(result).toBe('/home/user/data')
  })
})

// ---------------------------------------------------------------------------
// defaultCheckWritable — real filesystem integration tests
// ---------------------------------------------------------------------------

describe('resolveDefaultDataDir — defaultCheckWritable filesystem behavior', () => {
  let tempHome: string
  let tempTmp: string

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'dd-home-test-'))
    tempTmp = await mkdtemp(join(tmpdir(), 'dd-tmp-test-'))
  })

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true })
    await rm(tempTmp, { recursive: true, force: true })
  })

  it('returns home candidate when ~/.whiteboard is a writable directory', async () => {
    const whiteboardDir = join(tempHome, '.whiteboard')
    await mkdir(whiteboardDir)
    const result = resolveDefaultDataDir({}, { homeDir: tempHome, tmpDir: tempTmp })
    expect(result).toBe(whiteboardDir)
  })

  it('falls back to tmp when home candidate is a regular file (not a directory)', async () => {
    // config.ts::canWriteDir fails with EEXIST+ENOTDIR when ~/.whiteboard
    // is a file, so the server falls back to tmp. This resolver must agree.
    const whiteboardFile = join(tempHome, '.whiteboard')
    await writeFile(whiteboardFile, 'not a directory')
    const result = resolveDefaultDataDir({}, { homeDir: tempHome, tmpDir: tempTmp })
    expect(result).toBe(join(tempTmp, '.whiteboard'))
  })
})
