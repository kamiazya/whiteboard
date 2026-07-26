import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { findFilesContainingBytes, listAllRegularFiles } from './smoke-artifact.mjs'

const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'smoke-artifact.mjs')

let dir: string | null = null

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

describe('findFilesContainingBytes', () => {
  it('finds the needle inside a binary (.wasm) file by raw bytes, not text decoding', () => {
    dir = mkdtempSync(join(tmpdir(), 'smoke-artifact-'))
    const binary = Buffer.concat([
      Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
      Buffer.from('unpkg.com/loro-crdt-map', 'utf-8'),
    ])
    writeFileSync(join(dir, 'loro_wasm_bg.wasm'), binary)

    const offenders = findFilesContainingBytes(dir, 'unpkg.com')

    expect(offenders).toEqual([join(dir, 'loro_wasm_bg.wasm')])
  })

  it('finds the needle regardless of file extension', () => {
    dir = mkdtempSync(join(tmpdir(), 'smoke-artifact-'))
    writeFileSync(join(dir, 'no-extension'), 'https://unpkg.com/x')
    writeFileSync(join(dir, 'ok.js'), 'const x = 1')

    const offenders = findFilesContainingBytes(dir, 'unpkg.com')

    expect(offenders).toEqual([join(dir, 'no-extension')])
  })

  it('recurses into subdirectories', () => {
    dir = mkdtempSync(join(tmpdir(), 'smoke-artifact-'))
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'fetch("https://unpkg.com/x")')

    const offenders = findFilesContainingBytes(dir, 'unpkg.com')

    expect(offenders).toEqual([join(dir, 'assets', 'index-abc123.js')])
  })

  it('returns no offenders when the needle is absent', () => {
    dir = mkdtempSync(join(tmpdir(), 'smoke-artifact-'))
    writeFileSync(join(dir, 'ok.js'), 'const x = 1')

    expect(findFilesContainingBytes(dir, 'unpkg.com')).toEqual([])
  })
})

describe('entry-point guard', () => {
  it('runs main() when invoked from a checkout path containing a space', () => {
    // import.meta.url percent-encodes a space as %20 while process.argv[1]
    // does not; a plain string comparison between the two would never match
    // for a checkout path like this, so main() would silently never run.
    //
    // The fixture dir is created as a sibling of this test file rather than
    // under os.tmpdir() because on macOS the OS temp root (and /tmp) is
    // itself reached through a /private symlink; import.meta.url resolves
    // through that symlink while argv[1] does not, producing a mismatch
    // unrelated to the space-encoding bug this test targets.
    dir = join(dirname(SCRIPT_PATH), 'tmp-entrypoint-guard-fixture space')
    mkdirSync(dir, { recursive: true })
    const scriptCopy = join(dir, 'smoke-artifact.mjs')
    copyFileSync(SCRIPT_PATH, scriptCopy)

    let stdout = ''
    let status = 0
    try {
      stdout = execFileSync('node', [scriptCopy], { encoding: 'utf-8' })
    } catch (error) {
      const execError = error as { stdout?: string; status?: number }
      stdout = execError.stdout ?? ''
      status = execError.status ?? 1
    }

    // No dist/ next to the copied script, so main() is expected to fail its
    // checks (status 1) — the point is that it ran at all and printed output,
    // instead of silently exiting 0 with nothing on stdout.
    expect(stdout).toContain('[smoke-artifact]')
    expect(status).toBe(1)
  })
})

describe('listAllRegularFiles', () => {
  it('lists files with any extension, not just html/js/css/txt', () => {
    dir = mkdtempSync(join(tmpdir(), 'smoke-artifact-'))
    writeFileSync(join(dir, 'a.wasm'), 'x')
    writeFileSync(join(dir, 'b'), 'y')

    const files = listAllRegularFiles(dir).sort()

    expect(files).toEqual([join(dir, 'a.wasm'), join(dir, 'b')].sort())
  })
})
