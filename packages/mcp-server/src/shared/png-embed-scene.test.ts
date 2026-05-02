import { describe, expect, it } from 'vitest'
import { embedExcalidrawScene } from './png-embed-scene.js'

// Minimal valid PNG: signature + IHDR + IEND. The dummy IHDR CRC is fine for
// our purposes — embedExcalidrawScene only needs a parseable chunk stream and
// a recognisable IEND boundary.
function makeMinimalPng(): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdrData = Buffer.from([
    0, 0, 0, 1, // width 1
    0, 0, 0, 1, // height 1
    8, // bit depth
    2, // color type RGB
    0, 0, 0,
  ])
  const ihdrLen = Buffer.alloc(4)
  ihdrLen.writeUInt32BE(ihdrData.length, 0)
  const ihdrType = Buffer.from('IHDR', 'latin1')
  const ihdrCrc = Buffer.alloc(4)
  const iendLen = Buffer.from([0, 0, 0, 0])
  const iendType = Buffer.from('IEND', 'latin1')
  const iendCrc = Buffer.from([0xae, 0x42, 0x60, 0x82])
  return Buffer.concat([sig, ihdrLen, ihdrType, ihdrData, ihdrCrc, iendLen, iendType, iendCrc])
}

function parseChunks(png: Buffer): Array<{ type: string; data: Buffer; crc: number }> {
  const chunks: Array<{ type: string; data: Buffer; crc: number }> = []
  let pos = 8
  while (pos + 12 <= png.length) {
    const len = png.readUInt32BE(pos)
    const type = png.subarray(pos + 4, pos + 8).toString('latin1')
    const data = png.subarray(pos + 8, pos + 8 + len)
    const crc = png.readUInt32BE(pos + 8 + len)
    chunks.push({ type, data, crc })
    pos += 12 + len
  }
  return chunks
}

function decodeTextChunk(data: Buffer): { keyword: string; text: string } {
  const sep = data.indexOf(0)
  return {
    keyword: data.subarray(0, sep).toString('latin1'),
    text: data.subarray(sep + 1).toString('latin1'),
  }
}

function crc32(bytes: Uint8Array): number {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = (t[(c ^ bytes[i]) & 0xff] as number) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

describe('embedExcalidrawScene', () => {
  it('inserts a tEXt chunk before IEND carrying the scene JSON under the Excalidraw keyword', () => {
    const scene = {
      type: 'excalidraw',
      version: 2,
      source: '@kamiazya/whiteboard',
      elements: [{ id: 'r1', type: 'rectangle' }],
      appState: { viewBackgroundColor: '#ffffff' },
      files: {},
    }
    const out = embedExcalidrawScene(makeMinimalPng(), scene)
    const chunks = parseChunks(out)
    // Order matters: tEXt must come before the closing IEND so PNG readers
    // process the metadata as part of the same image.
    const types = chunks.map((c) => c.type)
    expect(types).toContain('tEXt')
    expect(types[types.length - 1]).toBe('IEND')
    expect(types.indexOf('tEXt')).toBeLessThan(types.indexOf('IEND'))

    const tEXt = chunks.find((c) => c.type === 'tEXt')
    if (!tEXt) throw new Error('expected a tEXt chunk')
    const decoded = decodeTextChunk(tEXt.data)
    // Excalidraw's decodePngMetadata (data/image.ts) reads tEXt and matches
    // the keyword against MIME_TYPES.excalidraw — anything else is rejected
    // as INVALID, so getting this string exactly right is the entire point
    // of this test.
    expect(decoded.keyword).toBe('application/vnd.excalidraw+json')
    expect(JSON.parse(decoded.text)).toEqual(scene)
  })

  it('escapes non-ASCII characters so a Japanese label survives the Latin-1 tEXt transport', () => {
    const scene = {
      type: 'excalidraw',
      version: 2,
      source: '@kamiazya/whiteboard',
      elements: [{ id: 't1', type: 'text', text: '日本語ラベル' }],
    }
    const out = embedExcalidrawScene(makeMinimalPng(), scene)
    const tEXt = parseChunks(out).find((c) => c.type === 'tEXt')
    if (!tEXt) throw new Error('expected a tEXt chunk')
    const decoded = decodeTextChunk(tEXt.data)
    // The whole reason we escape: tEXt is Latin-1, so a literal Japanese
    // codepoint above U+00FF would be silently mangled when the Excalidraw
    // import path Latin-1-decodes the chunk.
    expect(/^[\x00-\x7f]*$/.test(decoded.text)).toBe(true)
    expect(JSON.parse(decoded.text)).toEqual(scene)
  })

  it('writes a CRC that matches the standard PNG CRC32 over type + data', () => {
    const out = embedExcalidrawScene(makeMinimalPng(), {
      type: 'excalidraw',
      version: 2,
      source: 't',
      elements: [],
    })
    const tEXt = parseChunks(out).find((c) => c.type === 'tEXt')
    if (!tEXt) throw new Error('expected a tEXt chunk')
    const expected = crc32(Buffer.concat([Buffer.from('tEXt', 'latin1'), tEXt.data]))
    expect(tEXt.crc).toBe(expected)
  })

  it('throws on input that is not a PNG', () => {
    expect(() => embedExcalidrawScene(Buffer.from([0, 1, 2, 3]), {})).toThrow(/PNG signature/)
  })

  it('throws when the PNG has no IEND chunk', () => {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(() => embedExcalidrawScene(sig, {})).toThrow(/IEND/)
  })
})
