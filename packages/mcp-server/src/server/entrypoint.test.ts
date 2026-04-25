import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { isDirectEntryPoint } from './entrypoint.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('isDirectEntryPoint', () => {
  it('returns true for the exact same file path', () => {
    const entryPath = resolve('/tmp/example-entry.mjs')

    expect(isDirectEntryPoint(pathToFileURL(entryPath).href, entryPath)).toBe(true)
  })

  it('returns true when argv[1] points at a symlink to the same file', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'whiteboard-entrypoint-'))
    tempDirs.push(tempDir)

    const realDir = join(tempDir, 'real')
    const aliasDir = join(tempDir, 'alias')
    const realEntryPath = join(realDir, 'entry.mjs')
    const symlinkEntryPath = join(aliasDir, 'entry.mjs')

    mkdirSync(realDir, { recursive: true })
    writeFileSync(realEntryPath, 'export {}')
    symlinkSync(realDir, aliasDir)

    expect(isDirectEntryPoint(pathToFileURL(realEntryPath).href, symlinkEntryPath)).toBe(true)
  })

  it('returns false for a different file path', () => {
    expect(
      isDirectEntryPoint(
        pathToFileURL('/tmp/real-entry.mjs').href,
        '/tmp/different-entry.mjs',
      ),
    ).toBe(false)
  })
})
