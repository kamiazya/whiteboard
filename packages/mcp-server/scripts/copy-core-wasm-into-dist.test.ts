import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CORE_WASM_FILES, copyCoreWasmIntoDist } from './copy-core-wasm-into-dist.mjs'

describe('copyCoreWasmIntoDist', () => {
  let dir: string | undefined

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  function staged(files: readonly string[]) {
    dir = mkdtempSync(join(tmpdir(), 'copy-core-wasm-into-dist-'))
    const srcDir = join(dir, 'artifacts')
    mkdirSync(srcDir, { recursive: true })
    for (const file of files) writeFileSync(join(srcDir, file), `bytes:${file}`)
    return { srcDir, destDir: join(dir, 'dist', 'assets', 'core-wasm') }
  }

  it('copies the glue, the wasm and the notices byte-identically', () => {
    const { srcDir, destDir } = staged(CORE_WASM_FILES)

    expect(copyCoreWasmIntoDist(srcDir, destDir)).toEqual({ copied: [...CORE_WASM_FILES] })

    for (const file of CORE_WASM_FILES) {
      expect(readFileSync(join(destDir, file), 'utf-8')).toBe(`bytes:${file}`)
    }
  })

  it('copies nothing, and says so, when no artifact is staged, so a plain local build still works', () => {
    const { srcDir, destDir } = staged([])

    expect(copyCoreWasmIntoDist(srcDir, destDir)).toEqual({ copied: [] })
  })

  it('refuses a half-staged artifact, which would load as a broken core', () => {
    const { srcDir, destDir } = staged(['whiteboard_wasm.js'])

    expect(() => copyCoreWasmIntoDist(srcDir, destDir)).toThrow(/whiteboard_wasm_bg\.wasm/)
  })
})
