import type { Rollup } from 'vite'
import { describe, expect, it } from 'vitest'
import { stripWasmSourceMapPlugin } from './vite-plugin-strip-wasm-sourcemap.js'

const WASM_MAGIC_AND_VERSION = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]

function uleb128(value: number): number[] {
  const out: number[] = []
  let v = value
  do {
    let byte = v & 0x7f
    v >>>= 7
    if (v !== 0) byte |= 0x80
    out.push(byte)
  } while (v !== 0)
  return out
}

function wasmWithSourceMappingUrlSection(url: string): Uint8Array {
  const nameBytes = Array.from(Buffer.from('sourceMappingURL', 'utf8'))
  const urlBytes = Array.from(Buffer.from(url, 'utf8'))
  const content = [
    ...uleb128(nameBytes.length),
    ...nameBytes,
    ...uleb128(urlBytes.length),
    ...urlBytes,
  ]
  const section = [0x00, ...uleb128(content.length), ...content]
  return new Uint8Array([...WASM_MAGIC_AND_VERSION, ...section])
}

/** Minimal stand-in for a Rollup output asset in bundle-mutation tests. */
function outputAsset(fileName: string, source: Uint8Array | string): Rollup.OutputAsset {
  return {
    type: 'asset',
    fileName,
    source,
    name: undefined,
    names: [],
    originalFileName: null,
    originalFileNames: [],
    needsCodeReference: false,
  } as unknown as Rollup.OutputAsset
}

function runGenerateBundle(bundle: Rollup.OutputBundle): void {
  const plugin = stripWasmSourceMapPlugin()
  const hook = plugin.generateBundle
  if (typeof hook !== 'function') {
    throw new Error('expected stripWasmSourceMapPlugin().generateBundle to be a plain function')
  }
  hook.call(
    {} as unknown as Rollup.PluginContext,
    {} as unknown as Rollup.NormalizedOutputOptions,
    bundle,
    true,
  )
}

describe('stripWasmSourceMapPlugin', () => {
  it('strips the sourceMappingURL section from a .wasm asset with a string source', () => {
    const wasm = wasmWithSourceMappingUrlSection('https://unpkg.com/x')
    const bundle: Rollup.OutputBundle = {
      'app.wasm': outputAsset('app.wasm', Buffer.from(wasm).toString('binary')),
    }

    runGenerateBundle(bundle)

    const stripped = bundle['app.wasm']
    if (!stripped || stripped.type !== 'asset') throw new Error('expected asset to survive')
    expect(Buffer.isBuffer(stripped.source)).toBe(true)
    expect((stripped.source as Buffer).includes('unpkg.com')).toBe(false)
  })

  it('strips the sourceMappingURL section from a .wasm asset with a Uint8Array source', () => {
    const wasm = wasmWithSourceMappingUrlSection('https://unpkg.com/x')
    const bundle: Rollup.OutputBundle = {
      'app.wasm': outputAsset('app.wasm', wasm),
    }

    runGenerateBundle(bundle)

    const stripped = bundle['app.wasm']
    if (!stripped || stripped.type !== 'asset') throw new Error('expected asset to survive')
    expect((stripped.source as Buffer).includes('unpkg.com')).toBe(false)
  })

  it('leaves non-wasm assets untouched', () => {
    const originalSource = 'body { color: red }'
    const bundle: Rollup.OutputBundle = {
      'app.css': outputAsset('app.css', originalSource),
    }

    runGenerateBundle(bundle)

    const untouched = bundle['app.css']
    if (!untouched || untouched.type !== 'asset') throw new Error('expected asset to survive')
    expect(untouched.source).toBe(originalSource)
  })
})
