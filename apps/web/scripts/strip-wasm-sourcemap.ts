// Strips a wasm custom section named `sourceMappingURL` from a wasm module's
// raw bytes. loro-crdt's bundler build ships one pointing at
// https://unpkg.com/loro-crdt-map@<version>/bundler/loro_wasm_bg.wasm.map —
// with DevTools open, Chrome eagerly fetches that URL, which violates our
// deployed connect-src (and would otherwise force widening the CSP to an
// unrelated third-party CDN just to silence a devtools-only fetch).
//
// Binary layout (https://webassembly.github.io/spec/core/binary/modules.html):
//   magic(4) version(4) section* ; section = id(1) size(uleb128) content(size)
// A custom section (id 0) starts its content with a `name` vector
// (uleb128 length + utf8 bytes); everything after the name is opaque
// section-specific payload we never need to look inside.

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d]
const HEADER_LENGTH = 8 // magic(4) + version(4)
const CUSTOM_SECTION_ID = 0
const SOURCE_MAPPING_URL_SECTION_NAME = 'sourceMappingURL'

interface ULEB128Result {
  value: number
  bytesRead: number
}

function readULEB128(bytes: Uint8Array, offset: number): ULEB128Result {
  let result = 0
  let shift = 0
  let bytesRead = 0
  for (;;) {
    if (offset + bytesRead >= bytes.length) {
      throw new Error('truncated wasm module: unterminated ULEB128')
    }
    const byte = bytes[offset + bytesRead] as number
    bytesRead++
    result |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) break
    shift += 7
  }
  // >>> 0 keeps the result an unsigned 32-bit integer; wasm section sizes
  // never approach 2^31 in practice for the artifacts this strips.
  return { value: result >>> 0, bytesRead }
}

function hasWasmMagic(bytes: Uint8Array): boolean {
  return WASM_MAGIC.every((byte, i) => bytes[i] === byte)
}

/**
 * Removes any custom section named `sourceMappingURL` from a wasm module.
 * Byte-identical to the input for every other section, in original order.
 * Non-wasm or truncated input is returned unchanged rather than throwing —
 * this runs inside a build plugin where a parse surprise must not break the
 * build; the smoke-artifact unpkg.com scan is the backstop that catches a
 * silently-unstripped module.
 */
export function stripWasmSourceMap(bytes: Uint8Array): Uint8Array {
  if (bytes.length < HEADER_LENGTH || !hasWasmMagic(bytes)) {
    return bytes
  }

  const chunks: Uint8Array[] = [bytes.subarray(0, HEADER_LENGTH)]
  let offset = HEADER_LENGTH
  let changed = false

  while (offset < bytes.length) {
    const sectionStart = offset
    const id = bytes[offset]
    const cursor = offset + 1
    let sizeInfo: ULEB128Result
    try {
      sizeInfo = readULEB128(bytes, cursor)
    } catch {
      // Truncated trailing bytes: keep them verbatim rather than dropping data.
      chunks.push(bytes.subarray(sectionStart))
      offset = bytes.length
      break
    }
    const contentStart = cursor + sizeInfo.bytesRead
    const contentEnd = contentStart + sizeInfo.value
    if (contentEnd > bytes.length) {
      // Malformed/truncated module — bail out and keep the remainder as-is.
      chunks.push(bytes.subarray(sectionStart))
      offset = bytes.length
      break
    }

    let isSourceMappingUrlSection = false
    if (id === CUSTOM_SECTION_ID) {
      try {
        const nameInfo = readULEB128(bytes, contentStart)
        const nameStart = contentStart + nameInfo.bytesRead
        const nameEnd = nameStart + nameInfo.value
        if (nameEnd <= contentEnd) {
          const name = Buffer.from(bytes.subarray(nameStart, nameEnd)).toString('utf8')
          isSourceMappingUrlSection = name === SOURCE_MAPPING_URL_SECTION_NAME
        }
      } catch {
        isSourceMappingUrlSection = false
      }
    }

    if (isSourceMappingUrlSection) {
      changed = true
    } else {
      chunks.push(bytes.subarray(sectionStart, contentEnd))
    }
    offset = contentEnd
  }

  if (!changed) {
    return bytes
  }

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const result = new Uint8Array(totalLength)
  let writeOffset = 0
  for (const chunk of chunks) {
    result.set(chunk, writeOffset)
    writeOffset += chunk.length
  }
  return result
}
