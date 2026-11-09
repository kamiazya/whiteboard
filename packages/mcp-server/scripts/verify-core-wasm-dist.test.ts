import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CORE_WASM_FILES } from './copy-core-wasm-into-dist.mjs'
import { findMissingCoreWasm } from './verify-core-wasm-dist.mjs'

describe('findMissingCoreWasm', () => {
  let packageRoot: string | undefined

  afterEach(() => {
    if (packageRoot) rmSync(packageRoot, { recursive: true, force: true })
    packageRoot = undefined
  })

  it('reports nothing missing when the glue, the wasm and the notices are all in dist', () => {
    packageRoot = mkdtempSync(join(tmpdir(), 'verify-core-wasm-dist-'))
    const dir = join(packageRoot, 'dist', 'assets', 'core-wasm')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, CORE_WASM_FILES[0] as string), 'x')
    // The wasm alone is not enough: the glue instantiates it, the notices license it.
    expect(findMissingCoreWasm(packageRoot)).toContain(CORE_WASM_FILES[1])
    for (const file of CORE_WASM_FILES) writeFileSync(join(dir, file), 'x')
    expect(findMissingCoreWasm(packageRoot)).toBeNull()
  })

  it('reports the first missing path when the copy step never ran', () => {
    packageRoot = mkdtempSync(join(tmpdir(), 'verify-core-wasm-dist-'))

    expect(findMissingCoreWasm(packageRoot)).toBe(
      join(packageRoot, 'dist', 'assets', 'core-wasm', CORE_WASM_FILES[0] as string),
    )
  })
})
