import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findFilesContainingBytes, listAllRegularFiles } from './smoke-artifact.mjs'

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

describe('listAllRegularFiles', () => {
  it('lists files with any extension, not just html/js/css/txt', () => {
    dir = mkdtempSync(join(tmpdir(), 'smoke-artifact-'))
    writeFileSync(join(dir, 'a.wasm'), 'x')
    writeFileSync(join(dir, 'b'), 'y')

    const files = listAllRegularFiles(dir).sort()

    expect(files).toEqual([join(dir, 'a.wasm'), join(dir, 'b')].sort())
  })
})
