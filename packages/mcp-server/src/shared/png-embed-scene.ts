// Embed Excalidraw scene JSON into a rendered PNG buffer as a tEXt chunk so
// the file remains re-importable by Excalidraw (drag-drop / paste). The
// browser export path uses `@excalidraw/excalidraw`'s `encodePngMetadata`,
// which writes a tEXt chunk with keyword `application/vnd.excalidraw+json`
// and a JSON payload starting with `{"type":"excalidraw",...}`. The
// no-browser headless export path needs to produce a byte-identical contract
// or the `.excalidraw.png` file silently degrades to a dead PNG.
//
// We take the simpler-of-two interop branches Excalidraw's decoder accepts:
// uncompressed JSON. `decodePngMetadata` checks `"encoded" in payload` first
// (the pako-compressed form) and falls back to `"type" === "excalidraw"`,
// returning the raw text untouched — exactly what we write here.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// Mirrors @excalidraw/excalidraw's `MIME_TYPES.excalidraw`. Hard-coded
// instead of imported because the constant lives behind the runtime `dist/`
// barrel and reaching for it from the daemon path would pull in the whole
// browser bundle just to read one string.
const EXCALIDRAW_KEYWORD = 'application/vnd.excalidraw+json'

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    c = (CRC_TABLE[(c ^ bytes[i]) & 0xff] as number) ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

const NON_LATIN1 = /[-￿]/g

// PNG tEXt is Latin-1, so any codepoint above U+00FF would be silently
// mangled when the importer Latin-1-decodes the chunk. Escape every such
// char to `\uXXXX`: still valid JSON, pure ASCII (a strict subset of
// Latin-1), and `JSON.parse` reconstitutes the original characters on the
// way out.
function asciiSafeStringify(value: unknown): string {
  return JSON.stringify(value).replace(
    NON_LATIN1,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

function buildTextChunk(keyword: string, text: string): Buffer {
  const data = Buffer.concat([
    Buffer.from(keyword, 'latin1'),
    Buffer.from([0]),
    Buffer.from(text, 'latin1'),
  ])
  const type = Buffer.from('tEXt', 'latin1')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])), 0)
  return Buffer.concat([length, type, data, crc])
}

export function embedExcalidrawScene(png: Buffer, scene: unknown): Buffer {
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('embedExcalidrawScene: input does not start with the PNG signature')
  }
  let pos = 8
  let iendStart = -1
  while (pos + 12 <= png.length) {
    const len = png.readUInt32BE(pos)
    const type = png.subarray(pos + 4, pos + 8).toString('latin1')
    if (type === 'IEND') {
      iendStart = pos
      break
    }
    pos += 12 + len
  }
  if (iendStart === -1) {
    throw new Error('embedExcalidrawScene: PNG has no IEND chunk')
  }
  const textChunk = buildTextChunk(EXCALIDRAW_KEYWORD, asciiSafeStringify(scene))
  return Buffer.concat([png.subarray(0, iendStart), textChunk, png.subarray(iendStart)])
}

export const EXCALIDRAW_PNG_METADATA_KEYWORD = EXCALIDRAW_KEYWORD
