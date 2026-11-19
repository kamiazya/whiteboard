import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EXPECTED_ABI, ORACLE_ABI } from './index.js'

/**
 * A panic aborts the wasm instance (`panic = "abort"`), and plain `initSync`
 * keeps returning the dead one. wasm-bindgen's reset-state function is what a
 * recovering shim can call instead; this holds that it exists in the glue and
 * brings a trapped instance back, against the oracle artifact that carries
 * the deliberate trap.
 */

const dir = process.env.WHITEBOARD_WASM_DIR ?? ''
const shippedWasm = new URL('../artifacts/whiteboard_wasm_bg.wasm', import.meta.url)

interface OracleGlue {
  initSync(init: { module: BufferSource }): unknown
  abi_version(): string
  poison_instance(): void
  __wbg_reset_state(): void
}

describe('recovering a wasm instance a panic aborted', () => {
  it('traps on the deliberate panic and answers from a fresh instance after a reset', async () => {
    const glue = (await import(pathToFileURL(join(dir, 'whiteboard_wasm.js')).href)) as OracleGlue
    glue.initSync({ module: readFileSync(join(dir, 'whiteboard_wasm_bg.wasm')) })
    expect(glue.abi_version()).toBe(ORACLE_ABI)
    expect(ORACLE_ABI).toBe(`${EXPECTED_ABI}+oracle-surface`)

    expect(() => glue.poison_instance()).toThrow(WebAssembly.RuntimeError)
    // The trap does not make later calls fail: the aborted instance keeps
    // answering over whatever state the panic interrupted, which is why the
    // shim must discard it rather than wait for an error.
    expect(() => glue.poison_instance()).toThrow(WebAssembly.RuntimeError)

    glue.__wbg_reset_state()
    expect(glue.abi_version()).toBe(ORACLE_ABI)
  })

  it('leaves the deliberate trap out of the shipped artifact, which can still be reset', () => {
    const names = WebAssembly.Module.exports(new WebAssembly.Module(readFileSync(shippedWasm))).map(
      (e) => e.name,
    )
    expect(names).toContain('abi_version')
    expect(names).not.toContain('poison_instance')
    const glue = readFileSync(new URL('../artifacts/whiteboard_wasm.js', import.meta.url), 'utf8')
    expect(glue).toContain('__wbg_reset_state')
  })
})
