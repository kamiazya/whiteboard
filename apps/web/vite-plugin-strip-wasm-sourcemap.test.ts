import type { Rollup } from 'vite'
import { describe, expect, it } from 'vitest'
import { bytesContain } from './src/test-utils/byte-search.js'
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
    expect(bytesContain(stripped.source as Buffer, 'unpkg.com')).toBe(false)
  })

  it('preserves bytes >= 0x80 in a string (latin1) source instead of UTF-8-corrupting them', () => {
    // Real wasm modules are full of high bytes; a latin1 string source must
    // decode one-char-per-byte. TextEncoder (UTF-8) would expand each >= 0x80
    // byte into a multi-byte sequence and grow/garble the module. Append a
    // non-.wasm-recognized trailer of high bytes after the header so the
    // stripper passes it through unchanged and we can assert byte identity.
    const highBytes = [0x80, 0xc3, 0xff, 0x90, 0xa5]
    const wasm = new Uint8Array([...WASM_MAGIC_AND_VERSION, ...highBytes])
    const bundle: Rollup.OutputBundle = {
      'app.wasm': outputAsset('app.wasm', Buffer.from(wasm).toString('latin1')),
    }

    runGenerateBundle(bundle)

    const stripped = bundle['app.wasm']
    if (!stripped || stripped.type !== 'asset') throw new Error('expected asset to survive')
    const out = stripped.source as Buffer
    // Byte-identical to the original: latin1 round-trips, UTF-8 would not.
    expect(Buffer.from(out).equals(Buffer.from(wasm))).toBe(true)
  })

  it('strips the sourceMappingURL section from a .wasm asset with a Uint8Array source', () => {
    const wasm = wasmWithSourceMappingUrlSection('https://unpkg.com/x')
    const bundle: Rollup.OutputBundle = {
      'app.wasm': outputAsset('app.wasm', wasm),
    }

    runGenerateBundle(bundle)

    const stripped = bundle['app.wasm']
    if (!stripped || stripped.type !== 'asset') throw new Error('expected asset to survive')
    expect(bytesContain(stripped.source as Buffer, 'unpkg.com')).toBe(false)
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
