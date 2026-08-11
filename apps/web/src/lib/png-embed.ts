/**
 * Editable-PNG embedding, the draw.io pattern: the exported PNG carries its
 * source document in an iTXt chunk, so a shared image IS the canvas (exact
 * coordinates included), not just pixels of it. iTXt over tEXt because the
 * payload is UTF-8 JSON and tEXt is Latin-1 only (PNG 1.2 §4.2.3).
 *
 * Both functions are total over hostile input: a buffer that is not a PNG,
 * or a truncated chunk stream, extracts to null and embeds by returning the
 * input untouched — an export must never fail because embedding could not
 * parse what the rasterizer produced.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Standard PNG CRC-32 (ISO 3309 / ITU-T V.42), over chunk type + data. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0
  }
  return (crc ^ 0xffffffff) >>> 0
}

interface Chunk {
  readonly type: string
  readonly data: Uint8Array
}

function readChunks(png: Uint8Array): Chunk[] | null {
  if (png.length < 8 || PNG_SIGNATURE.some((b, i) => png[i] !== b)) return null
  const chunks: Chunk[] = []
  let offset = 8
  while (offset + 12 <= png.length) {
    const len =
      ((png[offset]! << 24) |
        (png[offset + 1]! << 16) |
        (png[offset + 2]! << 8) |
        png[offset + 3]!) >>>
      0
    if (offset + 12 + len > png.length) return null
    const type = String.fromCharCode(
      png[offset + 4]!,
      png[offset + 5]!,
      png[offset + 6]!,
      png[offset + 7]!,
    )
    chunks.push({ type, data: png.slice(offset + 8, offset + 8 + len) })
    offset += 12 + len
    if (type === 'IEND') return chunks
  }
  return null
}

function writeChunks(chunks: readonly Chunk[]): Uint8Array {
  const total = 8 + chunks.reduce((sum, chunk) => sum + 12 + chunk.data.length, 0)
  const out = new Uint8Array(total)
  out.set(PNG_SIGNATURE, 0)
  let offset = 8
  for (const chunk of chunks) {
    const len = chunk.data.length
    out[offset] = (len >>> 24) & 0xff
    out[offset + 1] = (len >>> 16) & 0xff
    out[offset + 2] = (len >>> 8) & 0xff
    out[offset + 3] = len & 0xff
    const typeAndData = new Uint8Array(4 + len)
    for (let i = 0; i < 4; i++) typeAndData[i] = chunk.type.charCodeAt(i)
    typeAndData.set(chunk.data, 4)
    out.set(typeAndData, offset + 4)
    const crc = crc32(typeAndData)
    const crcAt = offset + 8 + len
    out[crcAt] = (crc >>> 24) & 0xff
    out[crcAt + 1] = (crc >>> 16) & 0xff
    out[crcAt + 2] = (crc >>> 8) & 0xff
    out[crcAt + 3] = crc & 0xff
    offset += 12 + len
  }
  return out
}

/** iTXt layout: keyword\0 compressed(0) method(0) lang\0 translated\0 text. */
function iTXtChunk(keyword: string, text: string): Chunk {
  const keywordBytes = new TextEncoder().encode(keyword)
  const textBytes = new TextEncoder().encode(text)
  const data = new Uint8Array(keywordBytes.length + 5 + textBytes.length)
  data.set(keywordBytes, 0)
  // keyword NUL, compression flag 0, compression method 0, empty language
  // tag NUL, empty translated keyword NUL — five zero bytes in a row.
  data.set(textBytes, keywordBytes.length + 5)
  return { type: 'iTXt', data }
}

function iTXtKeywordOf(data: Uint8Array): string | null {
  const nul = data.indexOf(0)
  if (nul <= 0) return null
  return new TextDecoder().decode(data.slice(0, nul))
}

/**
 * Returns `png` with an iTXt chunk carrying `text` under `keyword`,
 * replacing any existing chunk with that keyword. Inserted before IEND.
 */
export function embedTextInPng(png: Uint8Array, keyword: string, text: string): Uint8Array {
  const chunks = readChunks(png)
  if (chunks === null) return png
  const kept = chunks.filter(
    (chunk) => !(chunk.type === 'iTXt' && iTXtKeywordOf(chunk.data) === keyword),
  )
  const iend = kept.findIndex((chunk) => chunk.type === 'IEND')
  if (iend === -1) return png
  kept.splice(iend, 0, iTXtChunk(keyword, text))
  return writeChunks(kept)
}

/** The text stored under `keyword`, or null when absent or not a PNG. */
export function extractTextFromPng(png: Uint8Array, keyword: string): string | null {
  const chunks = readChunks(png)
  if (chunks === null) return null
  for (const chunk of chunks) {
    if (chunk.type !== 'iTXt') continue
    if (iTXtKeywordOf(chunk.data) !== keyword) continue
    const keywordLen = new TextEncoder().encode(keyword).length
    // Skip keyword NUL + 2 method bytes, then the two NUL-terminated
    // optional fields (language tag, translated keyword).
    let offset = keywordLen + 3
    for (let field = 0; field < 2; field++) {
      const nul = chunk.data.indexOf(0, offset)
      if (nul === -1) return null
      offset = nul + 1
    }
    return new TextDecoder().decode(chunk.data.slice(offset))
  }
  return null
}
