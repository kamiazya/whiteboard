import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { stripWasmSourceMap } from './strip-wasm-sourcemap.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

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

function customSection(name: string, payload: number[]): number[] {
  const nameBytes = Array.from(Buffer.from(name, 'utf8'))
  const content = [...uleb128(nameBytes.length), ...nameBytes, ...payload]
  return [0x00, ...uleb128(content.length), ...content]
}

function typeSection(): number[] {
  // A minimal, syntactically valid empty type section (id 1, vec length 0).
  return [0x01, ...uleb128(1), 0x00]
}

function buildWasm(sections: number[][]): Uint8Array {
  const magicAndVersion = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
  return new Uint8Array([...magicAndVersion, ...sections.flat()])
}

describe('stripWasmSourceMap', () => {
  it('removes a sourceMappingURL custom section pointing at an external URL', () => {
    const url = 'https://unpkg.com/loro-crdt-map@1.13.6/bundler/loro_wasm_bg.wasm.map'
    const urlBytes = Array.from(Buffer.from(url, 'utf8'))
    const wasm = buildWasm([
      typeSection(),
      customSection('sourceMappingURL', [...uleb128(urlBytes.length), ...urlBytes]),
    ])

    const stripped = stripWasmSourceMap(wasm)

    expect(Buffer.from(stripped).includes('unpkg.com')).toBe(false)
    expect(Buffer.from(stripped).includes('sourceMappingURL')).toBe(false)
    expect(WebAssembly.validate(stripped)).toBe(true)
  })

  it('preserves every other section byte-identically and in order', () => {
    const producers = customSection('producers', [0x01, 0x02, 0x03])
    const url = 'https://unpkg.com/x'
    const urlBytes = Array.from(Buffer.from(url, 'utf8'))
    const wasm = buildWasm([
      typeSection(),
      producers,
      customSection('sourceMappingURL', [...uleb128(urlBytes.length), ...urlBytes]),
    ])

    const stripped = stripWasmSourceMap(wasm)

    // magic+version + typeSection + producers section, verbatim.
    const expected = Buffer.from(buildWasm([typeSection(), producers]))
    expect(Buffer.from(stripped).equals(expected)).toBe(true)
  })

  it('returns the input unchanged when there is no sourceMappingURL section', () => {
    const wasm = buildWasm([typeSection(), customSection('producers', [0x01])])

    const stripped = stripWasmSourceMap(wasm)

    expect(Buffer.from(stripped).equals(Buffer.from(wasm))).toBe(true)
  })

  it('is idempotent', () => {
    const url = 'https://unpkg.com/x'
    const urlBytes = Array.from(Buffer.from(url, 'utf8'))
    const wasm = buildWasm([
      typeSection(),
      customSection('sourceMappingURL', [...uleb128(urlBytes.length), ...urlBytes]),
    ])

    const once = stripWasmSourceMap(wasm)
    const twice = stripWasmSourceMap(once)

    expect(Buffer.from(twice).equals(Buffer.from(once))).toBe(true)
  })

  it('leaves non-wasm input untouched instead of throwing', () => {
    const notWasm = new Uint8Array([1, 2, 3, 4])
    expect(stripWasmSourceMap(notWasm)).toBe(notWasm)
  })

  it('strips the unpkg.com sourceMappingURL from the real loro-crdt bundler wasm artifact', () => {
    const wasmPath = resolve(__dirname, '../node_modules/loro-crdt/bundler/loro_wasm_bg.wasm')
    const original = readFileSync(wasmPath)
    expect(original.includes('unpkg.com')).toBe(true) // guards against the fixture going stale

    const stripped = stripWasmSourceMap(new Uint8Array(original))

    expect(Buffer.from(stripped).includes('unpkg.com')).toBe(false)
    expect(WebAssembly.validate(stripped)).toBe(true)
  })

  it('keeps a section with a truncated (unterminated) ULEB128 size verbatim instead of throwing', () => {
    const magicAndVersion = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
    const typeSectionBytes = typeSection()
    // A trailing section id followed only by continuation-flagged ULEB128 bytes
    // (high bit set, never terminated) — the buffer ends mid-varint.
    const truncatedTail = [0x00, 0x80, 0x80]
    const wasm = new Uint8Array([...magicAndVersion, ...typeSectionBytes, ...truncatedTail])

    const stripped = stripWasmSourceMap(wasm)

    expect(Buffer.from(stripped).equals(Buffer.from(wasm))).toBe(true)
  })

  it('keeps a section whose declared size overruns the buffer verbatim instead of throwing', () => {
    const magicAndVersion = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
    const typeSectionBytes = typeSection()
    // Custom section (id 0) claiming a content size (200) far larger than the
    // bytes actually available after it.
    const overrunSection = [0x00, ...uleb128(200), 0x01, 0x02, 0x03]
    const wasm = new Uint8Array([...magicAndVersion, ...typeSectionBytes, ...overrunSection])

    const stripped = stripWasmSourceMap(wasm)

    expect(Buffer.from(stripped).equals(Buffer.from(wasm))).toBe(true)
  })

  it('returns the input unchanged when a truncated section follows a valid sourceMappingURL section', () => {
    const url = 'https://unpkg.com/x'
    const urlBytes = Array.from(Buffer.from(url, 'utf8'))
    const sourceMappingSection = customSection('sourceMappingURL', [
      ...uleb128(urlBytes.length),
      ...urlBytes,
    ])
    // A trailing section id followed only by continuation-flagged ULEB128 bytes
    // (high bit set, never terminated) — the buffer ends mid-varint, after a
    // removable section was already seen.
    const truncatedTail = [0x00, 0x80, 0x80]
    const wasm = new Uint8Array([
      ...buildWasm([typeSection(), sourceMappingSection]),
      ...truncatedTail,
    ])

    const stripped = stripWasmSourceMap(wasm)

    expect(Buffer.from(stripped).equals(Buffer.from(wasm))).toBe(true)
  })

  it('leaves a custom section untouched when its declared name length overruns its own content', () => {
    // Custom section content: name-length ULEB128 (10) but only 3 bytes of
    // name/payload actually follow — nameEnd > contentEnd inside the section.
    const oversizedNameContent = [...uleb128(10), 0x61, 0x62, 0x63]
    const malformedCustomSection = [
      0x00,
      ...uleb128(oversizedNameContent.length),
      ...oversizedNameContent,
    ]
    const wasm = buildWasm([typeSection(), malformedCustomSection])

    const stripped = stripWasmSourceMap(wasm)

    expect(Buffer.from(stripped).equals(Buffer.from(wasm))).toBe(true)
  })
})
